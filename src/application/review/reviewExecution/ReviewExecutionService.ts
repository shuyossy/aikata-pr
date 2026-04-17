import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import type { MrGateway } from '../../shared/port/gateway/index.js';
import type { MrDiscussionGateway } from '../../shared/port/gateway/index.js';
import type { ProjectTreeGateway } from '../../shared/port/gateway/index.js';
import type { SuggestDiscussion } from '../../shared/port/gateway/index.js';
import type {
  ReviewWorkflowParams,
  ReviewWorkflowResult,
  ReviewWorkflowRunner,
} from '../../shared/port/workflow/index.js';
import { CommentParser } from '../../shared/comment/index.js';
import type { ReviewExecutionCommand } from './ReviewExecutionCommand.js';
import type { ReviewExecutionDto } from './ReviewExecutionDto.js';
import { ReviewResult } from '../../../domain/review/reviewResult/index.js';
import { Rating } from '../../../domain/review/rating/index.js';
import { Suggestion } from '../../../domain/review/suggestion/index.js';
import { ResolvedSuggestion } from '../../../domain/review/suggestion/index.js';
import type { MrContext } from '../../../domain/review/mrContext/index.js';
import { compressDiffIfNeeded } from '../../shared/diffCompression/index.js';
import type { TokenCounter } from '../../shared/port/tokenCounter/index.js';
import { buildUserPromptTemplate } from '../../shared/prompt/index.js';

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
 * suggest関連のコンテキスト
 */
interface SuggestContext {
  activeSuggests: Array<{
    checkItemContent: string;
    filePath: string;
    originalCode: string;
    suggestedCode: string;
    comment: string;
  }> | null;
  suggestsToResolveIds: string[];
}

/**
 * AIレビュー実行専用サービス
 * MRコンテキスト取得→Workflow実行→レビュー結果返却を担当する
 * コメント投稿や品質ゲート評価は含まない
 */
export class ReviewExecutionService {
  constructor(
    private readonly mrGateway: MrGateway,
    private readonly mrDiscussionGateway: MrDiscussionGateway,
    private readonly workflowRunner: ReviewWorkflowRunner,
    private readonly projectTreeGateway: ProjectTreeGateway,
    private readonly tokenCounter: TokenCounter,
  ) {}

  async execute(command: ReviewExecutionCommand): Promise<ReviewExecutionDto> {
    const [mrContext, comments, suggestDiscussions, folderTree] = await Promise.all([
      this.mrGateway.getMrContext(command.projectId, command.mrIid),
      this.mrDiscussionGateway.getReviewDiscussions(command.projectId, command.mrIid),
      this.mrDiscussionGateway.getSuggestDiscussions(command.projectId, command.mrIid),
      this.projectTreeGateway.getTree(command.projectDir, { maxDepth: command.treeMaxDepth }),
    ]);

    // suggest関連のコンテキストを構築
    const suggestContext = this.buildSuggestContext(command, suggestDiscussions);

    const priorContext = await this.buildPriorContext(command, comments, mrContext.commitHash);

    // リトライ判定: 前回レビューのコミットハッシュと今回のコミットハッシュが一致する場合
    const isRetry =
      priorContext.priorCommitHash !== null &&
      priorContext.priorCommitHash === mrContext.commitHash;

    if (isRetry) {
      return this.executeRetryReview(command, mrContext, priorContext, folderTree, suggestContext);
    }
    return this.executeFullReview(command, mrContext, priorContext, folderTree, suggestContext);
  }

  /**
   * 通常のフルレビューを実行する
   */
  private async executeFullReview(
    command: ReviewExecutionCommand,
    mrContext: MrContext,
    priorContext: PriorContext,
    folderTree: string,
    suggestContext: SuggestContext,
  ): Promise<ReviewExecutionDto> {
    const resultFilePath = join(
      os.tmpdir(),
      `aikata-review-${command.projectId}-${command.mrIid}-${Date.now()}.json`,
    );
    const suggestResultFilePath = join(
      os.tmpdir(),
      `aikata-suggest-${command.projectId}-${command.mrIid}-${Date.now()}.json`,
    );

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
          suggestResultFilePath,
          suggestContext,
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
      const suggestions = this.convertToResolvedSuggestions(workflowResult);

      return {
        results,
        commitHash: mrContext.commitHash,
        commitMessage: mrContext.commitMessage,
        suggestions,
        suggestsToResolve: suggestContext.suggestsToResolveIds,
        baseSha: mrContext.baseSha,
        headSha: mrContext.headSha,
        startSha: mrContext.startSha,
      };
    } finally {
      this.cleanupTempFiles(resultFilePath);
      this.cleanupTempFiles(suggestResultFilePath);
    }
  }

  /**
   * リトライ時のレビューを実行する
   * 前回成功した項目はそのまま保持し、エラー項目と未レビュー項目のみ再レビューする
   */
  private async executeRetryReview(
    command: ReviewExecutionCommand,
    mrContext: MrContext,
    priorContext: PriorContext,
    folderTree: string,
    suggestContext: SuggestContext,
  ): Promise<ReviewExecutionDto> {
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

    // 再レビュー対象なし → 前回結果をそのまま返却
    if (itemsToReview.length === 0) {
      return {
        results: keptResults,
        commitHash: mrContext.commitHash,
        commitMessage: mrContext.commitMessage,
        suggestions: [],
        suggestsToResolve: suggestContext.suggestsToResolveIds,
        baseSha: mrContext.baseSha,
        headSha: mrContext.headSha,
        startSha: mrContext.startSha,
      };
    }

    // 再レビュー対象あり → ワークフロー実行（対象項目のみ）
    const resultFilePath = join(
      os.tmpdir(),
      `aikata-review-${command.projectId}-${command.mrIid}-${Date.now()}.json`,
    );
    const suggestResultFilePath = join(
      os.tmpdir(),
      `aikata-suggest-${command.projectId}-${command.mrIid}-${Date.now()}.json`,
    );

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
          suggestResultFilePath,
          suggestContext,
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
      const suggestions = this.convertToResolvedSuggestions(workflowResult);

      // マージ（チェックリスト順）
      const mergedResults = command.checklist.items.map((item) => {
        const kept = keptResults.find((r) => r.checkItem.content === item.content);
        if (kept) return kept;
        const newResult = newResults.find((r) => r.checkItem.content === item.content);
        if (newResult) return newResult;
        throw new Error(`Result not found for item: ${item.content}`);
      });

      return {
        results: mergedResults,
        commitHash: mrContext.commitHash,
        commitMessage: mrContext.commitMessage,
        suggestions,
        suggestsToResolve: suggestContext.suggestsToResolveIds,
        baseSha: mrContext.baseSha,
        headSha: mrContext.headSha,
        startSha: mrContext.startSha,
      };
    } finally {
      this.cleanupTempFiles(resultFilePath);
      this.cleanupTempFiles(suggestResultFilePath);
    }
  }

  /**
   * ワークフロー共通パラメータを構築する
   * mrDiff, omittedFileDiffs, diffCompressed, folderTreeRemovedByCompressionは
   * 圧縮処理の結果に応じて呼び出し元で個別に設定する
   */
  private buildCommonWorkflowParams(
    command: ReviewExecutionCommand,
    mrContext: MrContext,
    folderTree: string,
    resultFilePath: string,
    suggestResultFilePath: string,
    suggestContext: SuggestContext,
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
      projectId: command.projectId,
      aiApiKey: command.aiApiKey,
      aiApiEndpointUrl: command.aiApiEndpointUrl,
      aiModelName: command.aiModelName,
      projectDir: command.projectDir,
      skillsPaths: command.skillsPaths,
      resultFilePath,
      folderTree,
      commentLanguage: command.commentLanguage,
      openaiReasoningEffort: command.openaiReasoningEffort,
      suggestEnabledRatingLabels: command.suggestEnabledRatingLabels,
      activeSuggests: suggestContext.activeSuggests,
      suggestResultFilePath,
      fullMrDiff: mrContext.diff,
    };
  }

  /**
   * diff圧縮を実行する（MAX_CONTEXT_LENGTH指定時のみ）
   */
  private compressDiff(
    command: ReviewExecutionCommand,
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

    const compressionResult = compressDiffIfNeeded(
      (diff, ft) => this.buildEstimatedUserPrompt(command, mrContext, diff, ft, priorContext),
      mrContext.diff,
      folderTree,
      this.tokenCounter,
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
    command: ReviewExecutionCommand,
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
    command: ReviewExecutionCommand,
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
    command: ReviewExecutionCommand,
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
   * suggest関連のコンテキストを構築する
   * suggestEnabledRatingLabelsが空の場合はsuggest無効としてactiveSuggestsをnullにする
   */
  private buildSuggestContext(
    command: ReviewExecutionCommand,
    suggestDiscussions: SuggestDiscussion[],
  ): SuggestContext {
    // suggest無効の場合
    if (!command.reviewSettings.isSuggestEnabled()) {
      return {
        activeSuggests: null,
        suggestsToResolveIds: suggestDiscussions.map((s) => s.discussionId),
      };
    }

    const currentCheckItemContents = command.checklist.items.map((i) => i.content);

    // アクティブなsuggest: hasChangedSinceNote=falseかつ現在のチェックリストに含まれる
    const activeSuggests = suggestDiscussions.filter(
      (s) => !s.hasChangedSinceNote && currentCheckItemContents.includes(s.checkItemContent),
    );

    // resolve対象: アクティブでないもの
    const activeIds = new Set(activeSuggests.map((s) => s.discussionId));
    const suggestsToResolveIds = suggestDiscussions
      .filter((s) => !activeIds.has(s.discussionId))
      .map((s) => s.discussionId);

    return {
      activeSuggests: activeSuggests.map((s) => ({
        checkItemContent: s.checkItemContent,
        filePath: s.filePath,
        originalCode: s.originalCode,
        suggestedCode: s.suggestedCode,
        comment: s.comment,
      })),
      suggestsToResolveIds,
    };
  }

  /**
   * ワークフロー結果のsuggestionsをResolvedSuggestionに変換する
   */
  private convertToResolvedSuggestions(workflowResult: ReviewWorkflowResult): ResolvedSuggestion[] {
    return workflowResult.suggestions.map(
      (s) =>
        new ResolvedSuggestion({
          suggestion: new Suggestion({
            checkItemContent: s.checkItemContent,
            filePath: s.filePath,
            originalCode: s.originalCode,
            suggestedCode: s.suggestedCode,
            comment: s.comment,
          }),
          newLine: s.newLine,
          linesAbove: s.linesAbove,
          linesBelow: s.linesBelow,
          oldPath: s.oldPath,
          newPath: s.newPath,
        }),
    );
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
