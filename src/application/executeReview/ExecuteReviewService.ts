import * as fs from 'node:fs';
import type { MrGateway } from '../shared/port/gateway/index.js';
import type { MrCommentGateway } from '../shared/port/gateway/index.js';
import type { ProjectTreeGateway } from '../shared/port/gateway/index.js';
import { CommentFormatter } from '../shared/comment/index.js';
import { CommentParser } from '../shared/comment/index.js';
import type { ExecuteReviewCommand } from './ExecuteReviewCommand.js';
import type { ExecuteReviewDto } from './ExecuteReviewDto.js';
import { ReviewResult } from '../../domain/reviewResult/index.js';
import { Rating } from '../../domain/rating/index.js';
import type { MrContext } from '../../domain/mrContext/index.js';

/**
 * ワークフロー実行のパラメータ
 */
export interface ReviewWorkflowParams {
  checkItemContents: string[];
  concurrentReviewCount: number | null;
  ratings: Array<{ label: string; definition: string }>;
  commentFormat: string;
  additionalInstructions: string;
  mrTitle: string;
  mrDescription: string;
  mrSourceBranch: string;
  mrTargetBranch: string;
  mrDiff: string;
  mrCommitHash: string;
  priorReviewResults: Array<{
    checkItemContent: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
  }> | null;
  priorCommitMessages: string[] | null;
  priorDiffSincePrior: string | null;
  userId: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  projectDir: string;
  skillsPaths: string[];
  resultFilePath: string;
  folderTree: string;
  commentLanguage: string;
  openaiReasoningEffort: string | undefined;
}

/**
 * ワークフロー実行の結果
 */
export interface ReviewWorkflowResult {
  results: Array<{
    checkItemContent: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError: boolean;
    errorMessage?: string;
  }>;
}

/**
 * ワークフロー実行のインターフェース（Mastra Workflowの実行をラップ）
 */
export interface ReviewWorkflowRunner {
  run(params: ReviewWorkflowParams): Promise<ReviewWorkflowResult>;
}

/**
 * buildPriorContextの返り値型
 */
interface PriorContext {
  priorCommitHash: string | null;
  priorReviewResults: Array<{
    checkItemContent: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
  }> | null;
  priorCommitMessages: string[] | null;
  priorDiffSincePrior: string | null;
}

/**
 * レビュー実行のメインオーケストレーションサービス
 * 事前処理→Workflow実行→コメント投稿の全フローを制御する
 */
export class ExecuteReviewService {
  constructor(
    private readonly mrGateway: MrGateway,
    private readonly mrCommentGateway: MrCommentGateway,
    private readonly workflowRunner: ReviewWorkflowRunner,
    private readonly projectTreeGateway: ProjectTreeGateway,
  ) {}

  async execute(command: ExecuteReviewCommand): Promise<ExecuteReviewDto> {
    const [mrContext, comments, folderTree] = await Promise.all([
      this.mrGateway.getMrContext(command.projectId, command.mrIid),
      this.mrCommentGateway.getComments(command.projectId, command.mrIid),
      this.projectTreeGateway.getTree(command.projectDir, { maxDepth: command.treeMaxDepth }),
    ]);

    const priorContext = await this.buildPriorContext(command, comments, mrContext.commitHash);

    // リトライ判定: 前回レビューのコミットハッシュと今回のコミットハッシュが一致する場合
    const isRetry =
      priorContext.priorCommitHash !== null &&
      priorContext.priorCommitHash === mrContext.commitHash;

    if (isRetry) {
      return this.executeRetryReview(command, mrContext, priorContext, folderTree);
    }
    return this.executeFullReview(command, mrContext, priorContext, folderTree);
  }

  /**
   * 通常のフルレビューを実行する
   */
  private async executeFullReview(
    command: ExecuteReviewCommand,
    mrContext: MrContext,
    priorContext: PriorContext,
    folderTree: string,
  ): Promise<ExecuteReviewDto> {
    const resultFilePath = `/tmp/aikata-review-${command.projectId}-${command.mrIid}-${Date.now()}.json`;

    try {
      const workflowResult = await this.workflowRunner.run({
        checkItemContents: command.checklist.items.map((i) => i.content),
        ...this.buildCommonWorkflowParams(command, mrContext, folderTree, resultFilePath),
        priorReviewResults: priorContext.priorReviewResults,
        priorCommitMessages: priorContext.priorCommitMessages,
        priorDiffSincePrior: priorContext.priorDiffSincePrior,
      });

      const results = this.convertToReviewResults(workflowResult, command);

      const commentBody = CommentFormatter.formatComment(
        results,
        command.reviewSettings.ratings,
        mrContext.commitHash,
        mrContext.commitMessage,
      );
      await this.mrCommentGateway.postComment(command.projectId, command.mrIid, commentBody);

      return {
        results,
        commitHash: mrContext.commitHash,
        commentPosted: true,
        allResultsAreErrors: ReviewResult.allAreErrors(results),
      };
    } finally {
      this.cleanupTempFiles(resultFilePath);
    }
  }

  /**
   * リトライ時のレビューを実行する
   * 前回成功した項目はそのまま保持し、エラー項目と未レビュー項目のみ再レビューする
   */
  private async executeRetryReview(
    command: ExecuteReviewCommand,
    mrContext: MrContext,
    priorContext: PriorContext,
    folderTree: string,
  ): Promise<ExecuteReviewDto> {
    // 前回成功結果をReviewResult[]に変換（保持する）
    const keptResults = (priorContext.priorReviewResults ?? []).map((r) => {
      const checkItem = command.checklist.items.find((i) => i.content === r.checkItemContent);
      if (!checkItem) {
        throw new Error(`Check item not found: ${r.checkItemContent}`);
      }
      return ReviewResult.success(
        checkItem,
        new Rating(r.ratingLabel, r.ratingDefinition),
        r.comment,
      );
    });

    // 再レビュー対象を特定（保持されなかった項目 = エラー + 未レビュー）
    const keptContents = new Set(keptResults.map((r) => r.checkItem.content));
    const itemsToReview = command.checklist.items.filter((i) => !keptContents.has(i.content));

    // 再レビュー対象なし → 前回結果をそのまま投稿
    if (itemsToReview.length === 0) {
      const commentBody = CommentFormatter.formatComment(
        keptResults,
        command.reviewSettings.ratings,
        mrContext.commitHash,
        mrContext.commitMessage,
      );
      await this.mrCommentGateway.postComment(command.projectId, command.mrIid, commentBody);
      return {
        results: keptResults,
        commitHash: mrContext.commitHash,
        commentPosted: true,
        allResultsAreErrors: ReviewResult.allAreErrors(keptResults),
      };
    }

    // 再レビュー対象あり → ワークフロー実行（対象項目のみ）
    const resultFilePath = `/tmp/aikata-review-${command.projectId}-${command.mrIid}-${Date.now()}.json`;

    try {
      const workflowResult = await this.workflowRunner.run({
        checkItemContents: itemsToReview.map((i) => i.content),
        ...this.buildCommonWorkflowParams(command, mrContext, folderTree, resultFilePath),
        // リトライ時はprior context不要（同じdiff）
        priorReviewResults: null,
        priorCommitMessages: null,
        priorDiffSincePrior: null,
      });

      const newResults = this.convertToReviewResults(workflowResult, command);

      // マージ（チェックリスト順）
      const mergedResults = command.checklist.items.map((item) => {
        const kept = keptResults.find((r) => r.checkItem.content === item.content);
        if (kept) return kept;
        const newResult = newResults.find((r) => r.checkItem.content === item.content);
        if (newResult) return newResult;
        throw new Error(`Result not found for item: ${item.content}`);
      });

      const commentBody = CommentFormatter.formatComment(
        mergedResults,
        command.reviewSettings.ratings,
        mrContext.commitHash,
        mrContext.commitMessage,
      );
      await this.mrCommentGateway.postComment(command.projectId, command.mrIid, commentBody);

      return {
        results: mergedResults,
        commitHash: mrContext.commitHash,
        commentPosted: true,
        allResultsAreErrors: ReviewResult.allAreErrors(mergedResults),
      };
    } finally {
      this.cleanupTempFiles(resultFilePath);
    }
  }

  /**
   * ワークフロー共通パラメータを構築する
   */
  private buildCommonWorkflowParams(
    command: ExecuteReviewCommand,
    mrContext: MrContext,
    folderTree: string,
    resultFilePath: string,
  ): Omit<
    ReviewWorkflowParams,
    'checkItemContents' | 'priorReviewResults' | 'priorCommitMessages' | 'priorDiffSincePrior'
  > {
    return {
      concurrentReviewCount: command.reviewSettings.concurrentReviewCount,
      ratings: command.reviewSettings.ratings.map((r) => ({
        label: r.label,
        definition: r.definition,
      })),
      commentFormat: command.reviewSettings.commentFormat,
      additionalInstructions: command.reviewSettings.additionalInstructions,
      mrTitle: mrContext.title,
      mrDescription: mrContext.description,
      mrSourceBranch: mrContext.sourceBranch,
      mrTargetBranch: mrContext.targetBranch,
      mrDiff: mrContext.diff,
      mrCommitHash: mrContext.commitHash,
      userId: command.userId,
      aiApiKey: command.aiApiKey,
      aiApiEndpointUrl: command.aiApiEndpointUrl,
      aiModelName: command.aiModelName,
      projectDir: command.projectDir,
      skillsPaths: command.skillsPaths,
      resultFilePath,
      folderTree,
      commentLanguage: command.commentLanguage,
      openaiReasoningEffort: command.openaiReasoningEffort,
    };
  }

  /**
   * 前回レビュー情報を構築する
   * 最新のaikataレビューコメントを見つけ、今回のチェックリストに含まれる項目のみフィルタする
   */
  private async buildPriorContext(
    command: ExecuteReviewCommand,
    comments: Array<{ id: number; body: string; createdAt: string }>,
    currentCommitHash: string,
  ): Promise<PriorContext> {
    // コメントを新しい順にソート（createdAtの降順）して最新のaikataコメントを見つける
    const sortedComments = [...comments].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const currentCheckItemContents = command.checklist.items.map((i) => i.content);

    for (const comment of sortedComments) {
      const parsed = CommentParser.parseComment(comment.body);
      if (!parsed) {
        continue;
      }

      // エラー結果を除外し、今回のチェックリストに含まれる項目のみフィルタ
      const filteredResults = parsed.results
        .filter((r) => !r.isError && currentCheckItemContents.includes(r.checkItem.content))
        .map((r) => ({
          checkItemContent: r.checkItem.content,
          ratingLabel: r.rating.label,
          ratingDefinition: r.rating.definition,
          comment: r.comment,
        }));

      if (filteredResults.length > 0) {
        const [priorCommitMessages, priorDiffSincePrior] = await Promise.all([
          this.mrGateway.getCommitsSince(command.projectId, command.mrIid, parsed.commitHash),
          this.mrGateway.getDiffSince(
            command.projectId,
            command.mrIid,
            parsed.commitHash,
            currentCommitHash,
          ),
        ]);

        return {
          priorCommitHash: parsed.commitHash,
          priorReviewResults: filteredResults,
          priorCommitMessages,
          priorDiffSincePrior,
        };
      }

      // 成功項目なし（全エラー等）でもcommitHashは返す（リトライ検知用）
      return {
        priorCommitHash: parsed.commitHash,
        priorReviewResults: null,
        priorCommitMessages: null,
        priorDiffSincePrior: null,
      };
    }

    return {
      priorCommitHash: null,
      priorReviewResults: null,
      priorCommitMessages: null,
      priorDiffSincePrior: null,
    };
  }

  /**
   * ワークフロー結果をドメイン型のReviewResultに変換する
   */
  private convertToReviewResults(
    workflowResult: ReviewWorkflowResult,
    command: ExecuteReviewCommand,
  ): ReviewResult[] {
    return workflowResult.results.map((r) => {
      const checkItem = command.checklist.items.find((i) => i.content === r.checkItemContent);
      if (!checkItem) {
        throw new Error(`Check item not found: ${r.checkItemContent}`);
      }

      if (r.isError) {
        return ReviewResult.error(checkItem, r.errorMessage ?? 'Unknown error');
      }

      return ReviewResult.success(
        checkItem,
        new Rating(r.ratingLabel, r.ratingDefinition),
        r.comment,
      );
    });
  }

  /**
   * 一時ファイルとロックディレクトリのクリーンアップ
   */
  private cleanupTempFiles(resultFilePath: string): void {
    try {
      fs.unlinkSync(resultFilePath);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(`${resultFilePath}.lock`);
    } catch {
      /* ignore */
    }
  }
}
