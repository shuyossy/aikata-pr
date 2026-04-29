import type { SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import type { CloneManagerPort } from '../../../application/shared/port/clone/index.js';
import type { RateLimiterPort } from '../../../application/shared/port/rateLimiter/index.js';
import type { ReviewWorkflowRunner } from '../../../application/shared/port/workflow/index.js';
import type { ReviewExecutionDto } from '../../../application/review/reviewExecution/index.js';
import { ReviewExecutionService } from '../../../application/review/reviewExecution/index.js';
import { GitLabApiClient } from '../../../infrastructure/adapter/httpClient/index.js';
import {
  GitLabMrGateway,
  LocalGitDiffMrGateway,
  LocalProjectTreeGateway,
} from '../../../infrastructure/adapter/gateway/index.js';
import { GitLabMrDiscussionGateway } from '../../../infrastructure/adapter/review/gateway/index.js';
import { ReviewSettings } from '../../../domain/review/reviewSettings/index.js';
import { Rating } from '../../../domain/review/rating/index.js';
import { QualityGate } from '../../../domain/review/qualityGate/index.js';
import { Checklist } from '../../../domain/review/checklist/index.js';
import { CheckItem } from '../../../domain/review/checkItem/index.js';
import type { ReviewExecutionCommand } from '../../../application/review/reviewExecution/index.js';
import type { ReviewApiResponse } from '../../../infrastructure/adapter/review/apiClient/ReviewApiClient.js';
import { GptTokenCounter } from '../../../infrastructure/adapter/tokenCounter/index.js';
import { getLogger } from '../../../lib/logger.js';
import type {
  JobResultStore,
  PendingJobResultRecord,
  SuccessJobResultRecord,
  FailedJobResultRecord,
} from '../../../application/shared/port/jobResultStore/index.js';
import { buildPendingJobRecord, handleExistingIdempotentJob } from '../shared/jobResult/index.js';

/**
 * レビューリクエストのバリデーションスキーマ
 */
export const reviewRequestSchema = z.object({
  userId: z.string().min(1),
  gitlabToken: z.string().min(1),
  projectId: z.string().min(1),
  mrIid: z.string().min(1),
  checklist: z.array(z.string().min(1)).min(1),
  reviewSettings: z
    .object({
      additionalInstructions: z.string().optional(),
      concurrentReviewCount: z.number().nullable().optional(),
      commentFormat: z.string().optional(),
      ratings: z
        .array(
          z.object({
            label: z.string().min(1),
            definition: z.string().min(1),
          }),
        )
        .min(1)
        .optional(),
      hiddenRatingLabels: z.array(z.string()).optional(),
      suggestEnabledRatingLabels: z.array(z.string()).optional(),
      qualityGate: z
        .object({
          failureCriteria: z
            .array(
              z.object({
                ratingLabel: z.string().min(1),
                threshold: z.number().min(1),
              }),
            )
            .optional(),
        })
        .optional(),
      mrCommentTitle: z.string().min(1).optional(),
    })
    .optional(),
  options: z
    .object({
      commentLanguage: z.string().optional(),
      skillsPaths: z.array(z.string()).optional(),
      treeMaxDepth: z.number().optional(),
    })
    .optional(),
});

/** バリデーション済みリクエスト型 */
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

/** SSEイベントの型定義 */
export interface SSEEvent {
  event: string;
  data: string;
}

/**
 * MR情報取得インターフェース（テスト時にモック可能）
 */
export interface MrInfoFetcher {
  fetchBranchInfo(
    projectId: string,
    mrIid: string,
  ): Promise<{ source_branch: string; target_branch: string }>;
}

/**
 * レビュー実行サービスインターフェース（テスト時にモック可能）
 */
export interface ReviewExecutor {
  execute(command: ReviewExecutionCommand): Promise<ReviewExecutionDto>;
}

/**
 * Per-requestサービスのファクトリ
 * クローン後にprojectDir等を使ってサービスを組み立てる
 */
export interface PerRequestServiceFactory {
  create(
    gitlabToken: string,
    gitlabApiBaseUrl: string,
    projectDir: string,
  ): {
    mrInfoFetcher: MrInfoFetcher;
    reviewExecutor: ReviewExecutor;
  };
}

/**
 * ReviewHandlerの依存インターフェース
 */
export interface ReviewHandlerDeps {
  cloneManager: CloneManagerPort;
  serviceFactory: PerRequestServiceFactory;
  rateLimiter: RateLimiterPort;
  jobResultStore: JobResultStore;
  /** ジョブ結果の保持期間（ミリ秒）。expiresAt = now + jobResultTtlMs */
  jobResultTtlMs: number;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  defaultAiModelName: string;
  gitlabApiBaseUrl: string;
  /** OpenAI reasoningモデルのreasoning effort設定 */
  openaiReasoningEffort?: string;
  /** レビュー全体タイムアウト（ミリ秒）。未設定時はタイムアウトなし */
  reviewTimeoutMs?: number;
  /** AIモデルのコンテキスト長（トークン数）。未設定時は圧縮しない */
  maxContextLength?: number;
}

/**
 * ReviewHandlerが受け取るリクエスト単位の実行コンテキスト
 */
export interface ReviewHandlerContext {
  /** ジョブID（= X-Request-Id） */
  jobId: string;
  /** クライアント生成のIdempotency-Key */
  idempotencyKey: string;
}

/**
 * デフォルトのPerRequestServiceFactory実装
 * 実際のインフラ層クラスを使用してサービスを組み立てる
 */
export class DefaultPerRequestServiceFactory implements PerRequestServiceFactory {
  constructor(private readonly workflowRunner: ReviewWorkflowRunner) {}

  create(
    gitlabToken: string,
    gitlabApiBaseUrl: string,
    projectDir: string,
  ): {
    mrInfoFetcher: MrInfoFetcher;
    reviewExecutor: ReviewExecutor;
  } {
    const gitlabClient = new GitLabApiClient(gitlabApiBaseUrl, gitlabToken);
    const apiMrGateway = new GitLabMrGateway(gitlabClient);
    const mrGateway = new LocalGitDiffMrGateway(projectDir, apiMrGateway, gitlabClient);
    const mrDiscussionGateway = new GitLabMrDiscussionGateway(gitlabClient);
    const treeGateway = new LocalProjectTreeGateway();

    const mrInfoFetcher: MrInfoFetcher = {
      fetchBranchInfo: async (projectId, mrIid) => {
        return gitlabClient.get<{ source_branch: string; target_branch: string }>(
          `/projects/${projectId}/merge_requests/${mrIid}`,
        );
      },
    };

    const reviewExecutor = new ReviewExecutionService(
      mrGateway,
      mrDiscussionGateway,
      this.workflowRunner,
      treeGateway,
      new GptTokenCounter(),
    );

    return { mrInfoFetcher, reviewExecutor };
  }
}

/**
 * レビューリクエストを処理するハンドラを生成するファクトリ
 *
 * 共有の依存をクロージャでキャプチャし、リクエストごとに
 * per-request依存をserviceFactory経由で組み立てる
 */
export function createReviewHandler(deps: ReviewHandlerDeps) {
  return async (
    request: ReviewRequest,
    stream: SSEStreamingApi,
    context: ReviewHandlerContext,
  ): Promise<void> => {
    const logger = getLogger();
    // オブジェクトに格納してクロージャ内からの代入をTypeScriptの制御フロー解析に追従させる
    const state: { cleanup: (() => Promise<void>) | null } = { cleanup: null };

    // 1. Idempotency-Key検査: 既存ジョブがあればAI処理を再実行せず結果を返す
    const existingJobOutcome = await handleExistingIdempotentJob({
      jobResultStore: deps.jobResultStore,
      stream,
      idempotencyKey: context.idempotencyKey,
      userId: request.userId,
      logger,
    });
    if (existingJobOutcome === 'handled-and-stop') {
      return;
    }

    // 2. pending状態のレコードを保存（best-effort、Idempotency-Key検知の起点）
    const pendingRecord: PendingJobResultRecord = buildPendingJobRecord({
      jobId: context.jobId,
      idempotencyKey: context.idempotencyKey,
      feature: 'review',
      userId: request.userId,
      ttlMs: deps.jobResultTtlMs,
    });
    try {
      await deps.jobResultStore.save(pendingRecord);
    } catch (err) {
      logger.warn(
        { err },
        'Failed to save pending job record (continuing best-effort, Idempotency-Key dedup may not work for retries)',
      );
    }

    // レートリミッターにプロジェクトを登録（参照カウント方式）
    deps.rateLimiter.registerProject(request.projectId);

    // keepaliveインターバル（30秒ごと）
    const keepaliveInterval = setInterval(async () => {
      try {
        await stream.writeSSE({ event: 'keepalive', data: '{}' });
      } catch {
        // ストリームが閉じられた場合は無視
      }
    }, 30_000);

    // タイムアウト制御
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      // タイムアウト付きのメイン処理をPromise.raceで制御
      const reviewPromise = async (): Promise<void> => {
        // SSE: 処理開始通知
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ status: 'started', message: 'Review process started' }),
        });

        // 2. MRブランチ情報取得用の一時サービス（クローン前はprojectDir不要な操作のみ）
        const preCloneServices = deps.serviceFactory.create(
          request.gitlabToken,
          deps.gitlabApiBaseUrl,
          '', // クローン前はprojectDirは空文字（MR情報取得のみ使用）
        );

        // 3. SSE: MR情報取得中
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ status: 'fetching_mr_info', message: 'Fetching MR metadata' }),
        });

        // 4. MRメタデータ取得（ブランチ名を得るため）
        const mrInfo = await preCloneServices.mrInfoFetcher.fetchBranchInfo(
          request.projectId,
          request.mrIid,
        );

        // 5. SSE: クローン中
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ status: 'cloning', message: 'Cloning repository' }),
        });

        // 6. リポジトリクローン
        const cloneResult = await deps.cloneManager.clone(
          request.gitlabToken,
          deps.gitlabApiBaseUrl,
          request.projectId,
          mrInfo.source_branch,
          mrInfo.target_branch,
          null,
        );
        state.cleanup = cloneResult.cleanup;

        logger.info(
          { projectId: request.projectId, projectDir: cloneResult.projectDir },
          'Repository cloned for API review',
        );

        // 7. クローン後のper-requestサービスを組み立て
        const services = deps.serviceFactory.create(
          request.gitlabToken,
          deps.gitlabApiBaseUrl,
          cloneResult.projectDir,
        );

        // 8. ドメインオブジェクト構築
        const checklist = new Checklist(request.checklist.map((c) => new CheckItem(c)));
        const reviewSettings = buildReviewSettings(request.reviewSettings);

        // 9. SSE: レビュー実行中
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ status: 'reviewing', message: 'Executing AI review' }),
        });

        // 10. AIレビュー実行
        const reviewResult = await services.reviewExecutor.execute({
          userId: request.userId,
          projectId: request.projectId,
          mrIid: request.mrIid,
          gitlabToken: request.gitlabToken,
          checklist,
          reviewSettings,
          skillsPaths: request.options?.skillsPaths ?? [],
          projectDir: cloneResult.projectDir,
          aiApiKey: deps.aiApiKey,
          aiApiEndpointUrl: deps.aiApiEndpointUrl,
          aiModelName: deps.defaultAiModelName,
          treeMaxDepth: request.options?.treeMaxDepth,
          commentLanguage: request.options?.commentLanguage ?? 'Japanese',
          openaiReasoningEffort: deps.openaiReasoningEffort,
          maxContextLength: deps.maxContextLength,
        });

        // 11. ReviewApiResponse形式でレビュー結果を構築
        const apiResponse: ReviewApiResponse = {
          results: reviewResult.results.map((r) => ({
            checkItemContent: r.checkItem.content,
            ratingLabel: r.rating.label,
            ratingDefinition: r.rating.definition,
            comment: r.comment,
            isError: r.isError,
            errorMessage: r.errorMessage ?? undefined,
          })),
          commitHash: reviewResult.commitHash,
          commitMessage: reviewResult.commitMessage,
          suggestions: reviewResult.suggestions.map((s) => ({
            checkItemContent: s.suggestion.checkItemContent,
            filePath: s.suggestion.filePath,
            originalCode: s.suggestion.originalCode,
            suggestedCode: s.suggestion.suggestedCode,
            comment: s.suggestion.comment,
            newLine: s.newLine,
            linesAbove: s.linesAbove,
            linesBelow: s.linesBelow,
            oldPath: s.oldPath,
            newPath: s.newPath,
          })),
          suggestResolveEntries: reviewResult.suggestsToResolve,
          baseSha: reviewResult.baseSha,
          headSha: reviewResult.headSha,
          startSha: reviewResult.startSha,
        };

        // 12. 結果を永続化（result送信の直前。SSE切断時はGET /jobs/{jobId}で再取得可能）
        const successRecord: SuccessJobResultRecord = {
          jobId: pendingRecord.jobId,
          idempotencyKey: pendingRecord.idempotencyKey,
          feature: pendingRecord.feature,
          userId: pendingRecord.userId,
          createdAt: pendingRecord.createdAt,
          updatedAt: new Date().toISOString(),
          expiresAt: pendingRecord.expiresAt,
          status: 'success',
          payload: apiResponse,
        };
        try {
          await deps.jobResultStore.save(successRecord);
        } catch (err) {
          logger.warn(
            { err },
            'Failed to save success job record (continuing best-effort, fallback polling may return stale state)',
          );
        }

        // 13. SSE: 結果送信（コメント投稿・品質ゲート評価はCLI側の責務）
        await stream.writeSSE({
          event: 'result',
          data: JSON.stringify(apiResponse),
        });

        // 14. SSE: 完了通知
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ status: 'completed', message: 'Review completed successfully' }),
        });

        logger.info(
          {
            projectId: request.projectId,
            mrIid: request.mrIid,
            resultCount: reviewResult.results.length,
          },
          'API review completed',
        );
      };

      // タイムアウトが設定されている場合はPromise.raceで制御
      if (deps.reviewTimeoutMs) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Review timed out after ${deps.reviewTimeoutMs}ms`));
          }, deps.reviewTimeoutMs);
        });
        await Promise.race([reviewPromise(), timeoutPromise]);
      } else {
        await reviewPromise();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'Review handler error');

      // エラーも永続化してフォールバックポーリングで取得可能にする
      const failedRecord: FailedJobResultRecord = {
        jobId: pendingRecord.jobId,
        idempotencyKey: pendingRecord.idempotencyKey,
        feature: pendingRecord.feature,
        userId: pendingRecord.userId,
        createdAt: pendingRecord.createdAt,
        updatedAt: new Date().toISOString(),
        expiresAt: pendingRecord.expiresAt,
        status: 'failed',
        errorMessage,
      };
      try {
        await deps.jobResultStore.save(failedRecord);
      } catch (saveErr) {
        logger.warn({ err: saveErr }, 'Failed to save failed job record (best-effort)');
      }

      try {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: errorMessage }),
        });
      } catch {
        // ストリームへの書き込みに失敗した場合は無視
      }
    } finally {
      clearInterval(keepaliveInterval);
      if (timeoutId) clearTimeout(timeoutId);
      // レートリミッターからプロジェクトを解除
      deps.rateLimiter.unregisterProject(request.projectId);
      // クリーンアップ（クローンした一時ディレクトリの削除）
      if (state.cleanup) {
        try {
          await state.cleanup();
        } catch (cleanupError) {
          logger.warn({ err: cleanupError }, 'Failed to cleanup cloned repository');
        }
      }
    }
  };
}

/**
 * リクエストのreviewSettings部分からドメインオブジェクトを構築する
 */
export function buildReviewSettings(settings: ReviewRequest['reviewSettings']): ReviewSettings {
  if (!settings) {
    return ReviewSettings.default();
  }

  const defaults = ReviewSettings.default();

  const ratings = settings.ratings
    ? settings.ratings.map((r) => new Rating(r.label, r.definition))
    : defaults.ratings;

  const rawCount = settings.concurrentReviewCount;
  const concurrentReviewCount =
    rawCount === undefined || rawCount === null || rawCount < 1 ? null : rawCount;

  const qualityGate = settings.qualityGate?.failureCriteria
    ? new QualityGate(settings.qualityGate.failureCriteria)
    : QualityGate.none();

  return new ReviewSettings({
    additionalInstructions: settings.additionalInstructions ?? defaults.additionalInstructions,
    concurrentReviewCount,
    commentFormat: settings.commentFormat ?? defaults.commentFormat,
    ratings,
    hiddenRatingLabels: settings.hiddenRatingLabels ?? [],
    suggestEnabledRatingLabels:
      settings.suggestEnabledRatingLabels ?? defaults.suggestEnabledRatingLabels,
    qualityGate,
    mrCommentTitle: settings.mrCommentTitle ?? defaults.mrCommentTitle,
  });
}
