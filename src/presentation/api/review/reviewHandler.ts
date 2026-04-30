import { z } from 'zod';
import type { Logger } from 'pino';
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
import type {
  JobResultStore,
  PendingJobResultRecord,
} from '../../../application/shared/port/jobResultStore/index.js';
import { runBackgroundJob } from '../../../application/shared/backgroundJob/index.js';
import { buildPendingJobRecord, resolveExistingIdempotentJob } from '../shared/jobResult/index.js';

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
  /** ハンドラ内で使うリクエスト固有logger（ルート側でログコンテキスト付きで生成） */
  logger: Logger;
  /** バックグラウンド処理に持ち越すログコンテキストバインディング */
  logBindings: Record<string, unknown>;
  /** バックグラウンド処理をログコンテキスト付きで実行するためのラッパ（`runWithLogContext` 相当） */
  runWithContext: <T>(bindings: Record<string, unknown>, fn: () => T) => T;
}

/**
 * Reviewハンドラの応答型（成功時）
 */
export interface ReviewJobSuccessResponse {
  jobId: string;
  feature: 'review';
  status: 'pending' | 'success' | 'failed';
  payload?: ReviewApiResponse;
  errorMessage?: string;
  currentStep?: string;
}

/**
 * Reviewハンドラの応答型（エラー時、4xx/5xx）
 */
export interface ReviewJobErrorResponse {
  error: string;
}

/**
 * ハンドラの戻り値（status・bodyの組）
 *
 * - status=200, body=ReviewJobSuccessResponse: 通常応答
 * - status=409, body=ReviewJobErrorResponse: Idempotency-Key衝突（別userId）
 * - status=500, body=ReviewJobErrorResponse: pending保存失敗等の内部エラー
 */
export type ReviewHandlerResult =
  | { status: 200; body: ReviewJobSuccessResponse }
  | { status: 409 | 500; body: ReviewJobErrorResponse };

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
 * レビューリクエストを処理するハンドラを生成するファクトリ。
 *
 * ハンドラの動作（SSE廃止後のJSON応答ベース）:
 * 1. Idempotency-Key検査 → 既存ジョブがあればそのstatusに応じて200で即時応答
 * 2. 衝突（別userId）→ 409で拒否
 * 3. pending同期保存 → 失敗時は500でエラー応答（AI処理は開始しない）
 * 4. AI処理を `runBackgroundJob` で fire-and-forget 起動
 * 5. 即座に 200 `{jobId, status: 'pending'}` を返却
 *
 * AI処理の進捗は `BackgroundJobUpdater.setCurrentStep` でpendingレコードに記録され、
 * CLI側は `GET /api/v1/jobs/{jobId}` をポーリングして取得する。
 */
export function createReviewHandler(deps: ReviewHandlerDeps) {
  return async (
    request: ReviewRequest,
    context: ReviewHandlerContext,
  ): Promise<ReviewHandlerResult> => {
    const logger = context.logger;

    // 1. Idempotency-Key検査
    const existingOutcome = await resolveExistingIdempotentJob({
      jobResultStore: deps.jobResultStore,
      idempotencyKey: context.idempotencyKey,
      userId: request.userId,
      logger,
    });

    if (existingOutcome.kind === 'collision') {
      return {
        status: 409,
        body: {
          error: 'Idempotency-Key conflicts with an existing job owned by a different user',
        },
      };
    }
    if (existingOutcome.kind === 'cached-success') {
      return {
        status: 200,
        body: {
          jobId: existingOutcome.jobId,
          feature: 'review',
          status: 'success',
          payload: existingOutcome.payload as ReviewApiResponse,
        },
      };
    }
    if (existingOutcome.kind === 'cached-failed') {
      return {
        status: 200,
        body: {
          jobId: existingOutcome.jobId,
          feature: 'review',
          status: 'failed',
          errorMessage: existingOutcome.errorMessage,
        },
      };
    }
    if (existingOutcome.kind === 'duplicated-pending') {
      const body: ReviewJobSuccessResponse = {
        jobId: existingOutcome.jobId,
        feature: 'review',
        status: 'pending',
      };
      if (existingOutcome.currentStep) body.currentStep = existingOutcome.currentStep;
      return { status: 200, body };
    }
    // 'no-existing' or 'lookup-failed' → 続行

    // 2. pending同期保存（必須。失敗時はAI処理を開始せず500を返す）
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
      logger.error({ err }, 'Failed to save pending job record (refusing to start AI work)');
      return {
        status: 500,
        body: { error: 'Failed to register job. Please retry.' },
      };
    }

    // 3. レートリミッターにプロジェクトを登録（cleanupでunregister）
    deps.rateLimiter.registerProject(request.projectId);

    // 4. バックグラウンドAI処理を起動（fire-and-forget）
    const cloneState: { cleanup: (() => Promise<void>) | null } = { cleanup: null };
    runBackgroundJob<ReviewApiResponse>({
      pendingRecord,
      jobResultStore: deps.jobResultStore,
      logger,
      runWithContext: context.runWithContext,
      contextBindings: context.logBindings,
      cleanup: async () => {
        deps.rateLimiter.unregisterProject(request.projectId);
        if (cloneState.cleanup) {
          try {
            await cloneState.cleanup();
          } catch (cleanupError) {
            logger.warn({ err: cleanupError }, 'Failed to cleanup cloned repository');
          }
        }
      },
      work: async (updater) => {
        const work = async (): Promise<ReviewApiResponse> => {
          await updater.setCurrentStep('fetching_mr_info');

          const preCloneServices = deps.serviceFactory.create(
            request.gitlabToken,
            deps.gitlabApiBaseUrl,
            '',
          );
          const mrInfo = await preCloneServices.mrInfoFetcher.fetchBranchInfo(
            request.projectId,
            request.mrIid,
          );

          await updater.setCurrentStep('cloning_repository');
          const cloneResult = await deps.cloneManager.clone(
            request.gitlabToken,
            deps.gitlabApiBaseUrl,
            request.projectId,
            mrInfo.source_branch,
            mrInfo.target_branch,
            null,
          );
          cloneState.cleanup = cloneResult.cleanup;
          logger.info(
            { projectId: request.projectId, projectDir: cloneResult.projectDir },
            'Repository cloned for API review',
          );

          const services = deps.serviceFactory.create(
            request.gitlabToken,
            deps.gitlabApiBaseUrl,
            cloneResult.projectDir,
          );

          const checklist = new Checklist(request.checklist.map((c) => new CheckItem(c)));
          const reviewSettings = buildReviewSettings(request.reviewSettings);

          await updater.setCurrentStep('reviewing');
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

          logger.info(
            {
              projectId: request.projectId,
              mrIid: request.mrIid,
              resultCount: reviewResult.results.length,
            },
            'API review completed',
          );

          return apiResponse;
        };

        // タイムアウトが設定されている場合は Promise.race で制御
        if (deps.reviewTimeoutMs) {
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`Review timed out after ${deps.reviewTimeoutMs}ms`));
            }, deps.reviewTimeoutMs);
          });
          try {
            return await Promise.race([work(), timeoutPromise]);
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }
        }
        return work();
      },
    });

    // 5. 即時応答（pending）
    return {
      status: 200,
      body: {
        jobId: pendingRecord.jobId,
        feature: 'review',
        status: 'pending',
      },
    };
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
