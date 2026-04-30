import { z } from 'zod';
import type { Logger } from 'pino';
import type { CloneManagerPort } from '../../../application/shared/port/clone/index.js';
import type { RateLimiterPort } from '../../../application/shared/port/rateLimiter/index.js';
import type { PipelineGateway } from '../../../application/shared/port/gateway/PipelineGateway.js';
import type {
  PipelineAnalysisProgressEvent,
  PipelineAnalysisWorkflowRunner,
} from '../../../application/shared/port/workflow/PipelineAnalysisWorkflowRunner.js';
import type { ProjectTreeGateway } from '../../../application/shared/port/gateway/ProjectTreeGateway.js';
import type { TokenCounter } from '../../../application/shared/port/tokenCounter/TokenCounter.js';
import {
  PipelineAnalysisService,
  type PipelineAnalyzeCommand,
} from '../../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import type { ArtifactArchiveReader } from '../../../application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.js';
import {
  ArtifactCacheManager,
  type ArtifactCacheOptions,
} from '../../../application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.js';
import { PipelineReportSettings } from '../../../domain/pipeline-report/pipelineReportSettings/index.js';
import type {
  JobResultStore,
  PendingJobResultRecord,
} from '../../../application/shared/port/jobResultStore/index.js';
import { runBackgroundJob } from '../../../application/shared/backgroundJob/index.js';
import { buildPendingJobRecord, resolveExistingIdempotentJob } from '../shared/jobResult/index.js';

/**
 * pipeline-report リクエストのバリデーションスキーマ
 *
 * 設計書 §8.3 に対応する zod スキーマ。
 * RegExp 文字列はハンドラ側でコンパイルする。
 */
export const pipelineReportRequestSchema = z.object({
  userId: z.string().min(1),
  gitlabToken: z.string().min(1),
  projectId: z.number().int().positive(),
  pipelineId: z.number().int().positive(),
  selfJobId: z.number().int().positive().nullable(),
  settings: z
    .object({
      jobReportFormat: z.string().optional(),
      analysisInstructions: z.string().nullable().optional(),
      reportRefinementInstructions: z.string().nullable().optional(),
      includeJobPatterns: z.array(z.string()).optional(),
      excludeJobPatterns: z.array(z.string()).optional(),
    })
    .optional(),
  commentLanguage: z.string().min(1),
  maxCompletenessRetries: z.number().int().min(0),
  skipCompletenessCheck: z.boolean().optional().default(false),
  skillsRelPaths: z.array(z.string()),
  /** フォルダツリー走査の最大深度。省略時は無制限 */
  treeMaxDepth: z.number().int().positive().optional(),
});

/** バリデーション済みリクエスト型 */
export type PipelineReportRequest = z.infer<typeof pipelineReportRequestSchema>;

/**
 * ハンドラが返す最終結果のペイロード型。
 */
export interface PipelineReportApiResponse {
  /** レポート本文（markdown） */
  reportContent: string;
  /** 完成判定フラグ */
  completenessVerified: boolean;
  /** 完成判定リトライ回数 */
  completenessRetries: number;
  /** workflow が失敗したが部分レポートを回復した場合に true */
  workflowFailed: boolean;
  /** 分析対象となったジョブ ID の一覧 */
  targetJobIds: number[];
  /** パイプライン情報 */
  pipeline: {
    projectId: number;
    pipelineId: number;
    ref: string;
    sha: string;
    status: string;
    webUrl: string;
  };
}

/**
 * テスト時に注入可能な最小限の PipelineAnalysisService インターフェース
 */
export interface PipelineAnalysisExecutor {
  analyze(command: PipelineAnalyzeCommand): ReturnType<PipelineAnalysisService['analyze']>;
}

/**
 * ref 取得用の最小限 Gateway インターフェース（PipelineGateway.getPipeline のみ使用）
 */
export interface PipelineMetaFetcher {
  getPipeline: PipelineGateway['getPipeline'];
}

/**
 * クローン後に per-request な PipelineAnalysisService を組み立てるファクトリ。
 */
export interface PipelineReportServiceFactory {
  create(
    gitlabToken: string,
    gitlabApiBaseUrl: string,
  ): {
    metaFetcher: PipelineMetaFetcher;
    executor: PipelineAnalysisExecutor;
  };
}

/**
 * PipelineReportHandler の依存インターフェース
 */
export interface PipelineReportHandlerDeps {
  cloneManager: CloneManagerPort;
  serviceFactory: PipelineReportServiceFactory;
  rateLimiter: RateLimiterPort;
  jobResultStore: JobResultStore;
  jobResultTtlMs: number;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  defaultAiModelName: string;
  gitlabApiBaseUrl: string;
  openaiReasoningEffort?: string;
  /** 解析全体タイムアウト（ミリ秒）。未設定時はタイムアウトなし */
  analysisTimeoutMs?: number;
  maxContextLength?: number;
}

/**
 * PipelineReportHandlerが受け取るリクエスト単位の実行コンテキスト
 */
export interface PipelineReportHandlerContext {
  /** ジョブID（= X-Request-Id） */
  jobId: string;
  /** クライアント生成のIdempotency-Key */
  idempotencyKey: string;
  logger: Logger;
  logBindings: Record<string, unknown>;
  runWithContext: <T>(bindings: Record<string, unknown>, fn: () => T) => T;
}

/**
 * pipeline-reportハンドラの応答型（成功時）
 */
export interface PipelineReportJobSuccessResponse {
  jobId: string;
  feature: 'pipeline-report';
  status: 'pending' | 'success' | 'failed';
  payload?: PipelineReportApiResponse;
  errorMessage?: string;
  currentStep?: string;
}

/**
 * pipeline-reportハンドラの応答型（エラー時、4xx/5xx）
 */
export interface PipelineReportJobErrorResponse {
  error: string;
}

export type PipelineReportHandlerResult =
  | { status: 200; body: PipelineReportJobSuccessResponse }
  | { status: 409 | 500; body: PipelineReportJobErrorResponse };

/**
 * 標準の PipelineReportServiceFactory 実装。
 */
export class DefaultPipelineReportServiceFactory implements PipelineReportServiceFactory {
  constructor(
    private readonly pipelineGatewayFactory: (
      gitlabToken: string,
      gitlabApiBaseUrl: string,
    ) => PipelineGateway,
    private readonly projectTreeGateway: ProjectTreeGateway,
    private readonly workflowRunner: PipelineAnalysisWorkflowRunner,
    private readonly tokenCounter: TokenCounter,
    private readonly archiveReader: ArtifactArchiveReader,
    private readonly artifactCacheOptions: ArtifactCacheOptions,
  ) {}

  create(
    gitlabToken: string,
    gitlabApiBaseUrl: string,
  ): {
    metaFetcher: PipelineMetaFetcher;
    executor: PipelineAnalysisExecutor;
  } {
    const pipelineGateway = this.pipelineGatewayFactory(gitlabToken, gitlabApiBaseUrl);
    const cacheManager = new ArtifactCacheManager(pipelineGateway, this.artifactCacheOptions);
    const executor = new PipelineAnalysisService(
      pipelineGateway,
      this.projectTreeGateway,
      this.workflowRunner,
      this.tokenCounter,
      this.archiveReader,
      cacheManager,
    );
    return {
      metaFetcher: {
        getPipeline: (projectId, pipelineId) => pipelineGateway.getPipeline(projectId, pipelineId),
      },
      executor,
    };
  }
}

/**
 * リクエストの settings 部分から PipelineReportSettings を構築する。
 */
export function buildPipelineReportSettings(
  settings: PipelineReportRequest['settings'],
): PipelineReportSettings {
  const defaults = PipelineReportSettings.default();
  if (!settings) {
    return defaults;
  }

  const compile = (patterns: string[] | undefined, field: string): RegExp[] => {
    if (!patterns || patterns.length === 0) return [];
    return patterns.map((src) => {
      try {
        return new RegExp(src);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid RegExp in ${field}: "${src}" — ${message}`, { cause: err });
      }
    });
  };

  return PipelineReportSettings.of({
    jobReportFormat: settings.jobReportFormat ?? defaults.jobReportFormat,
    analysisInstructions: settings.analysisInstructions ?? defaults.analysisInstructions,
    reportRefinementInstructions:
      settings.reportRefinementInstructions ?? defaults.reportRefinementInstructions,
    includeJobPatterns: compile(settings.includeJobPatterns, 'includeJobPatterns'),
    excludeJobPatterns: compile(settings.excludeJobPatterns, 'excludeJobPatterns'),
  });
}

/**
 * pipeline-report 用ハンドラ本体を生成するファクトリ。
 *
 * SSE廃止後の動作（reviewと同じパターン）:
 * 1. Idempotency-Key検査 → 既存ジョブの状態に応じて200で即時応答
 * 2. 衝突 → 409
 * 3. pending同期保存（失敗で500、AI処理は開始しない）
 * 4. AI処理を `runBackgroundJob` で fire-and-forget 起動（workflow phaseでcurrentStep更新）
 * 5. 即座に 200 `{jobId, status: 'pending'}` を返却
 */
export function createPipelineReportHandler(deps: PipelineReportHandlerDeps) {
  return async (
    request: PipelineReportRequest,
    context: PipelineReportHandlerContext,
  ): Promise<PipelineReportHandlerResult> => {
    const logger = context.logger;
    const projectIdStr = String(request.projectId);

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
          feature: 'pipeline-report',
          status: 'success',
          payload: existingOutcome.payload as PipelineReportApiResponse,
        },
      };
    }
    if (existingOutcome.kind === 'cached-failed') {
      return {
        status: 200,
        body: {
          jobId: existingOutcome.jobId,
          feature: 'pipeline-report',
          status: 'failed',
          errorMessage: existingOutcome.errorMessage,
        },
      };
    }
    if (existingOutcome.kind === 'duplicated-pending') {
      const body: PipelineReportJobSuccessResponse = {
        jobId: existingOutcome.jobId,
        feature: 'pipeline-report',
        status: 'pending',
      };
      if (existingOutcome.currentStep) body.currentStep = existingOutcome.currentStep;
      return { status: 200, body };
    }

    // 2. pending同期保存（必須）
    const pendingRecord: PendingJobResultRecord = buildPendingJobRecord({
      jobId: context.jobId,
      idempotencyKey: context.idempotencyKey,
      feature: 'pipeline-report',
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

    // 3. レートリミッター登録
    deps.rateLimiter.registerProject(projectIdStr);

    // 4. バックグラウンドAI処理を起動
    const cloneState: { cleanup: (() => Promise<void>) | null } = { cleanup: null };
    runBackgroundJob<PipelineReportApiResponse>({
      pendingRecord,
      jobResultStore: deps.jobResultStore,
      logger,
      runWithContext: context.runWithContext,
      contextBindings: context.logBindings,
      cleanup: async () => {
        deps.rateLimiter.unregisterProject(projectIdStr);
        if (cloneState.cleanup) {
          try {
            await cloneState.cleanup();
          } catch (cleanupError) {
            logger.warn({ err: cleanupError }, 'Failed to cleanup cloned repository');
          }
        }
      },
      work: async (updater) => {
        const work = async (): Promise<PipelineReportApiResponse> => {
          // 設定オブジェクト組み立て（RegExpコンパイル失敗はここで検出される）
          const settings = buildPipelineReportSettings(request.settings);

          // per-request サービス（metaFetcher + executor）を組み立てる
          const services = deps.serviceFactory.create(request.gitlabToken, deps.gitlabApiBaseUrl);

          await updater.setCurrentStep('fetching_pipeline');
          const pipelineMeta = await services.metaFetcher.getPipeline(
            request.projectId,
            request.pipelineId,
          );

          await updater.setCurrentStep('cloning_repository');
          const cloneResult = await deps.cloneManager.clone(
            request.gitlabToken,
            deps.gitlabApiBaseUrl,
            String(request.projectId),
            pipelineMeta.ref,
            pipelineMeta.ref,
            pipelineMeta.sha,
          );
          cloneState.cleanup = cloneResult.cleanup;
          logger.info(
            {
              projectId: request.projectId,
              pipelineId: request.pipelineId,
              projectDir: cloneResult.projectDir,
            },
            'Repository cloned for pipeline-report analysis',
          );

          await updater.setCurrentStep('analyzing');

          // workflow 内部の phase を currentStep に反映するコールバック
          const onProgress = (event: PipelineAnalysisProgressEvent): void => {
            if (event.type === 'phase') {
              // setCurrentStep は async だが、ワークフローを止めないため fire-and-forget
              void updater.setCurrentStep(`workflow_${event.phase}`);
            } else if (event.type === 'log') {
              const level =
                event.level === 'error' || event.level === 'warn' ? event.level : 'info';
              logger[level]({ event }, event.message);
            } else if (event.type === 'retry') {
              logger.warn(
                { event },
                `Retrying pipeline analysis: ${event.reason} (attempt ${event.retryCount})`,
              );
            }
          };

          const analysis = await services.executor.analyze({
            userId: request.userId,
            projectId: request.projectId,
            pipelineId: request.pipelineId,
            selfJobId: request.selfJobId,
            settings,
            projectDir: cloneResult.projectDir,
            commentLanguage: request.commentLanguage,
            skillsPaths: request.skillsRelPaths,
            aiConfig: {
              apiKey: deps.aiApiKey,
              endpointUrl: deps.aiApiEndpointUrl,
              modelName: deps.defaultAiModelName,
              reasoningEffort: deps.openaiReasoningEffort ?? null,
            },
            maxContextLength: deps.maxContextLength ?? null,
            treeMaxDepth: request.treeMaxDepth,
            options: {
              maxCompletenessRetries: request.maxCompletenessRetries,
              skipCompletenessCheck: request.skipCompletenessCheck ?? false,
            },
            onProgress,
          });

          const apiResponse: PipelineReportApiResponse = {
            reportContent: analysis.report.content,
            completenessVerified: analysis.completenessVerified,
            completenessRetries: analysis.completenessRetries,
            workflowFailed: analysis.workflowFailed,
            targetJobIds: analysis.targetJobs.map((j) => j.id),
            pipeline: {
              projectId: analysis.pipeline.projectId,
              pipelineId: analysis.pipeline.pipelineId,
              ref: analysis.pipeline.ref,
              sha: analysis.pipeline.sha,
              status: analysis.pipeline.status,
              webUrl: analysis.pipeline.webUrl,
            },
          };

          logger.info(
            {
              projectId: request.projectId,
              pipelineId: request.pipelineId,
              targetJobCount: analysis.targetJobs.length,
              completenessVerified: analysis.completenessVerified,
            },
            'Pipeline report API analysis completed',
          );

          return apiResponse;
        };

        if (deps.analysisTimeoutMs) {
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error(`Pipeline analysis timed out after ${deps.analysisTimeoutMs}ms`));
            }, deps.analysisTimeoutMs);
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
        feature: 'pipeline-report',
        status: 'pending',
      },
    };
  };
}
