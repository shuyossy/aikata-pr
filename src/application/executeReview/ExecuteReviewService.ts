import * as fs from 'node:fs';
import type { MrGateway } from '../shared/port/gateway/index.js';
import type { MrDiscussionGateway } from '../shared/port/gateway/index.js';
import type { ProjectTreeGateway } from '../shared/port/gateway/index.js';
import { CommentFormatter } from '../shared/comment/index.js';
import { CommentParser } from '../shared/comment/index.js';
import type { ExecuteReviewCommand } from './ExecuteReviewCommand.js';
import type { ExecuteReviewDto } from './ExecuteReviewDto.js';
import { ReviewResult } from '../../domain/reviewResult/index.js';
import { Rating } from '../../domain/rating/index.js';
import type { MrContext } from '../../domain/mrContext/index.js';
import { compressDiffIfNeeded } from '../shared/diffCompression/index.js';
import { GptTokenCounter } from '../../infrastructure/adapter/tokenCounter/index.js';
import { buildUserPromptTemplate } from '../shared/prompt/index.js';

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
  omittedFileDiffs: Record<string, string> | null;
  allDiffFilePaths: string[] | null;
  diffCompressed: boolean;
  folderTreeRemovedByCompression: boolean;
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
    private readonly mrDiscussionGateway: MrDiscussionGateway,
    private readonly workflowRunner: ReviewWorkflowRunner,
    private readonly projectTreeGateway: ProjectTreeGateway,
  ) {}

  async execute(command: ExecuteReviewCommand): Promise<ExecuteReviewDto> {
    const [mrContext, comments, folderTree] = await Promise.all([
      this.mrGateway.getMrContext(command.projectId, command.mrIid),
      this.mrDiscussionGateway.getDiscussions(command.projectId, command.mrIid),
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

    // diff圧縮（MAX_CONTEXT_LENGTH指定時のみ）
    const compression = this.compressDiff(command, mrContext, folderTree, priorContext);

    try {
      const workflowResult = await this.workflowRunner.run({
        checkItemContents: command.checklist.items.map((i) => i.content),
        ...this.buildCommonWorkflowParams(
          command,
          mrContext,
          compression.effectiveFolderTree,
          resultFilePath,
        ),
        mrDiff: compression.effectiveDiff,
        priorReviewResults: priorContext.priorReviewResults,
        priorCommitMessages: priorContext.priorCommitMessages,
        priorDiffSincePrior: priorContext.priorDiffSincePrior,
        omittedFileDiffs: compression.omittedFileDiffs,
        allDiffFilePaths: compression.allDiffFilePaths,
        diffCompressed: compression.diffCompressed,
        folderTreeRemovedByCompression: compression.folderTreeRemovedByCompression,
      });

      const results = this.convertToReviewResults(workflowResult, command);

      // 品質ゲート評価
      const qualityGateResult = command.reviewSettings.qualityGate.evaluate(results);

      // 全エラーの場合はコメントを投稿しない
      const allErrors = ReviewResult.allAreErrors(results);
      if (!allErrors) {
        const commentBody = CommentFormatter.formatComment(
          results,
          command.reviewSettings.ratings,
          mrContext.commitHash,
          mrContext.commitMessage,
          command.reviewSettings.hiddenRatingLabels,
          qualityGateResult,
        );
        await this.mrDiscussionGateway.postDiscussion(
          command.projectId,
          command.mrIid,
          commentBody,
        );
      }

      return {
        results,
        commitHash: mrContext.commitHash,
        commentPosted: !allErrors,
        allResultsAreErrors: allErrors,
        qualityGatePassed: qualityGateResult.passed,
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
      const qualityGateResult = command.reviewSettings.qualityGate.evaluate(keptResults);
      const commentBody = CommentFormatter.formatComment(
        keptResults,
        command.reviewSettings.ratings,
        mrContext.commitHash,
        mrContext.commitMessage,
        command.reviewSettings.hiddenRatingLabels,
        qualityGateResult,
      );
      await this.mrDiscussionGateway.postDiscussion(command.projectId, command.mrIid, commentBody);
      return {
        results: keptResults,
        commitHash: mrContext.commitHash,
        commentPosted: true,
        allResultsAreErrors: ReviewResult.allAreErrors(keptResults),
        qualityGatePassed: qualityGateResult.passed,
      };
    }

    // 再レビュー対象あり → ワークフロー実行（対象項目のみ）
    const resultFilePath = `/tmp/aikata-review-${command.projectId}-${command.mrIid}-${Date.now()}.json`;

    // diff圧縮（MAX_CONTEXT_LENGTH指定時のみ）
    const compression = this.compressDiff(command, mrContext, folderTree, null);

    try {
      const workflowResult = await this.workflowRunner.run({
        checkItemContents: itemsToReview.map((i) => i.content),
        ...this.buildCommonWorkflowParams(
          command,
          mrContext,
          compression.effectiveFolderTree,
          resultFilePath,
        ),
        mrDiff: compression.effectiveDiff,
        // リトライ時はprior context不要（同じdiff）
        priorReviewResults: null,
        priorCommitMessages: null,
        priorDiffSincePrior: null,
        omittedFileDiffs: compression.omittedFileDiffs,
        allDiffFilePaths: compression.allDiffFilePaths,
        diffCompressed: compression.diffCompressed,
        folderTreeRemovedByCompression: compression.folderTreeRemovedByCompression,
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

      // 品質ゲート評価
      const qualityGateResult = command.reviewSettings.qualityGate.evaluate(mergedResults);

      // 全エラーの場合はコメントを投稿しない
      const allErrors = ReviewResult.allAreErrors(mergedResults);
      if (!allErrors) {
        const commentBody = CommentFormatter.formatComment(
          mergedResults,
          command.reviewSettings.ratings,
          mrContext.commitHash,
          mrContext.commitMessage,
          command.reviewSettings.hiddenRatingLabels,
          qualityGateResult,
        );
        await this.mrDiscussionGateway.postDiscussion(
          command.projectId,
          command.mrIid,
          commentBody,
        );
      }

      return {
        results: mergedResults,
        commitHash: mrContext.commitHash,
        commentPosted: !allErrors,
        allResultsAreErrors: allErrors,
        qualityGatePassed: qualityGateResult.passed,
      };
    } finally {
      this.cleanupTempFiles(resultFilePath);
    }
  }

  /**
   * ワークフロー共通パラメータを構築する
   * mrDiff, omittedFileDiffs, diffCompressed, folderTreeRemovedByCompressionは
   * 圧縮処理の結果に応じて呼び出し元で個別に設定する
   */
  private buildCommonWorkflowParams(
    command: ExecuteReviewCommand,
    mrContext: MrContext,
    folderTree: string,
    resultFilePath: string,
  ): Omit<
    ReviewWorkflowParams,
    | 'checkItemContents'
    | 'priorReviewResults'
    | 'priorCommitMessages'
    | 'priorDiffSincePrior'
    | 'mrDiff'
    | 'omittedFileDiffs'
    | 'allDiffFilePaths'
    | 'diffCompressed'
    | 'folderTreeRemovedByCompression'
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
   * diff圧縮を実行する（MAX_CONTEXT_LENGTH指定時のみ）
   */
  private compressDiff(
    command: ExecuteReviewCommand,
    mrContext: MrContext,
    folderTree: string,
    priorContext: PriorContext | null,
  ): {
    effectiveDiff: string;
    effectiveFolderTree: string;
    omittedFileDiffs: Record<string, string> | null;
    allDiffFilePaths: string[] | null;
    diffCompressed: boolean;
    folderTreeRemovedByCompression: boolean;
  } {
    if (!command.maxContextLength) {
      return {
        effectiveDiff: mrContext.diff,
        effectiveFolderTree: folderTree,
        omittedFileDiffs: null,
        allDiffFilePaths: null,
        diffCompressed: false,
        folderTreeRemovedByCompression: false,
      };
    }

    const tokenCounter = new GptTokenCounter();
    const compressionResult = compressDiffIfNeeded(
      (diff, ft) => this.buildEstimatedUserPrompt(command, mrContext, diff, ft, priorContext),
      mrContext.diff,
      folderTree,
      tokenCounter,
      {
        maxContextLength: command.maxContextLength,
        thresholdRatio: 0.6,
        initialKeepPercent: 30,
        keepPercentStep: 5,
        minKeepPercent: 5,
      },
    );

    if (!compressionResult.compressed) {
      return {
        effectiveDiff: mrContext.diff,
        effectiveFolderTree: folderTree,
        omittedFileDiffs: null,
        allDiffFilePaths: null,
        diffCompressed: false,
        folderTreeRemovedByCompression: false,
      };
    }

    return {
      effectiveDiff: compressionResult.compressedDiff,
      effectiveFolderTree: compressionResult.folderTreeStripped
        ? compressionResult.strippedFolderTree
        : folderTree,
      omittedFileDiffs: Object.fromEntries(compressionResult.omittedFileDiffs),
      allDiffFilePaths: Array.from(compressionResult.allDiffFilePaths),
      diffCompressed: true,
      folderTreeRemovedByCompression: compressionResult.folderTreeStripped,
    };
  }

  /**
   * トークン数推定用のuserプロンプトを構築する
   * buildUserPromptTemplateを利用して実際のuserプロンプトと同一のロジックで構築する
   */
  private buildEstimatedUserPrompt(
    command: ExecuteReviewCommand,
    mrContext: MrContext,
    diff: string,
    folderTree: string,
    priorContext: PriorContext | null,
  ): string {
    return buildUserPromptTemplate({
      mrTitle: mrContext.title,
      mrDescription: mrContext.description,
      mrSourceBranch: mrContext.sourceBranch,
      mrTargetBranch: mrContext.targetBranch,
      mrDiff: diff,
      folderTree,
      priorReviewContext:
        priorContext?.priorReviewResults &&
        priorContext.priorCommitMessages &&
        priorContext.priorDiffSincePrior
          ? {
              results: priorContext.priorReviewResults.map((r) => ({
                checkItemContent: r.checkItemContent,
                ratingLabel: r.ratingLabel,
                comment: r.comment,
              })),
              commitMessages: priorContext.priorCommitMessages,
              diffSincePrior: priorContext.priorDiffSincePrior,
            }
          : null,
      checkItemCount: command.checklist.items.length,
    });
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

      // 表示結果と非表示結果をマージし、エラー結果を除外、今回のチェックリストに含まれる項目のみフィルタ
      const allResults = [...parsed.results, ...parsed.hiddenResults];
      const filteredResults = allResults
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
