import * as fs from 'node:fs';
import type { MrGateway } from '../shared/port/gateway/index.js';
import type { MrCommentGateway } from '../shared/port/gateway/index.js';
import { CommentFormatter } from '../shared/comment/index.js';
import { CommentParser } from '../shared/comment/index.js';
import type { ExecuteReviewCommand } from './ExecuteReviewCommand.js';
import type { ExecuteReviewDto } from './ExecuteReviewDto.js';
import { ReviewResult } from '../../domain/reviewResult/index.js';
import { Rating } from '../../domain/rating/index.js';

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
 * レビュー実行のメインオーケストレーションサービス
 * 事前処理→Workflow実行→コメント投稿の全フローを制御する
 */
export class ExecuteReviewService {
  constructor(
    private readonly mrGateway: MrGateway,
    private readonly mrCommentGateway: MrCommentGateway,
    private readonly workflowRunner: ReviewWorkflowRunner,
  ) {}

  async execute(command: ExecuteReviewCommand): Promise<ExecuteReviewDto> {
    const [mrContext, comments] = await Promise.all([
      this.mrGateway.getMrContext(command.projectId, command.mrIid),
      this.mrCommentGateway.getComments(command.projectId, command.mrIid),
    ]);

    const priorContext = await this.buildPriorContext(command, comments, mrContext.commitHash);

    const resultFilePath = `/tmp/aikata-review-${command.projectId}-${command.mrIid}-${Date.now()}.json`;

    try {
      const workflowResult = await this.workflowRunner.run({
        checkItemContents: command.checklist.items.map((i) => i.content),
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
        priorReviewResults: priorContext.priorReviewResults,
        priorCommitMessages: priorContext.priorCommitMessages,
        priorDiffSincePrior: priorContext.priorDiffSincePrior,
        userId: command.userId,
        aiApiKey: command.aiApiKey,
        aiApiEndpointUrl: command.aiApiEndpointUrl,
        aiModelName: command.aiModelName,
        projectDir: command.projectDir,
        skillsPaths: command.skillsPaths,
        resultFilePath,
        folderTree: command.folderTree,
        commentLanguage: command.commentLanguage,
      });

      const results = this.convertToReviewResults(workflowResult, command);

      const commentBody = CommentFormatter.formatComment(
        results,
        command.reviewSettings.ratings,
        mrContext.commitHash,
      );
      await this.mrCommentGateway.postComment(command.projectId, command.mrIid, commentBody);

      return {
        results,
        commitHash: mrContext.commitHash,
        commentPosted: true,
      };
    } finally {
      // 一時ファイルとロックディレクトリのクリーンアップ
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

  /**
   * 前回レビュー情報を構築する
   * 最新のaikataレビューコメントを見つけ、今回のチェックリストに含まれる項目のみフィルタする
   */
  private async buildPriorContext(
    command: ExecuteReviewCommand,
    comments: Array<{ id: number; body: string; createdAt: string }>,
    currentCommitHash: string,
  ): Promise<{
    priorReviewResults: Array<{
      checkItemContent: string;
      ratingLabel: string;
      ratingDefinition: string;
      comment: string;
    }> | null;
    priorCommitMessages: string[] | null;
    priorDiffSincePrior: string | null;
  }> {
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

      // 今回のチェックリストに含まれる項目のみフィルタ
      const filteredResults = parsed.results
        .filter((r) => currentCheckItemContents.includes(r.checkItem.content))
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
          priorReviewResults: filteredResults,
          priorCommitMessages,
          priorDiffSincePrior,
        };
      }

      // 最新のaikataコメントのみ使用（フィルタ後に項目がなくても他のコメントは探さない）
      break;
    }

    return {
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
}
