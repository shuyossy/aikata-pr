import type { SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
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
import { getLogger } from '../../../lib/logger.js';
import type {
  JobResultStore,
  PendingJobResultRecord,
  SuccessJobResultRecord,
  FailedJobResultRecord,
} from '../../../application/shared/port/jobResultStore/index.js';
import { buildPendingJobRecord, handleExistingIdempotentJob } from '../shared/jobResult/index.js';

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
 * ハンドラが返す最終 SSE 結果のペイロード型。
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
 * `create()` は以下の 2 つを同時に返す:
 * - `metaFetcher`: クローン前の ref 取得用
 * - `executor`: クローン後の analyze 実行用（内部で ArtifactCacheManager を保持）
 *
 * 同じ gitlabToken 由来の gateway を 2 つのオブジェクトで共有することで、
 * ハンドラが gateway を直接扱わずに済む設計にしている。
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
  /** クローンマネージャ（review と共有インスタンス） */
  cloneManager: CloneManagerPort;
  /** per-request サービスファクトリ（service は内部で gateway/workflow/archive 等を保持） */
  serviceFactory: PipelineReportServiceFactory;
  /** レートリミッター（review と共有インスタンス） */
  rateLimiter: RateLimiterPort;
  /** ジョブ結果ストア（review と共有インスタンス） */
  jobResultStore: JobResultStore;
  /** ジョブ結果の保持期間（ミリ秒） */
  jobResultTtlMs: number;
  /** ai API の共通情報（api key / endpoint / model） */
  aiApiKey: string;
  aiApiEndpointUrl: string;
  /** APIサーバー側で利用するデフォルトAIモデル名 */
  defaultAiModelName: string;
  /** GitLab API の base URL */
  gitlabApiBaseUrl: string;
  /** OpenAI reasoning モデルの reasoning effort 設定 */
  openaiReasoningEffort?: string;
  /** 解析全体タイムアウト（ミリ秒）。未設定時はタイムアウトなし */
  analysisTimeoutMs?: number;
  /** AIモデルのコンテキスト長（トークン数）。未設定時は圧縮しない */
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
}

/**
 * 標準の PipelineReportServiceFactory 実装。
 *
 * リクエストごとに ArtifactCacheManager と PipelineAnalysisService を組み立てる。
 * PipelineGateway は GitLab API クライアントに gitlabToken を束縛するため、
 * factory 経由で都度生成する。
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
 * includeJobPatterns / excludeJobPatterns は文字列配列で受け取り、ここで RegExp にコンパイルする。
 *
 * RegExp コンパイル失敗時は英語メッセージで Error を投げる（呼び出し側が SSE error として返す）。
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
 * pipeline-report 用 SSE ハンドラ本体を生成するファクトリ。
 *
 * 責務:
 * 1. バリデーション済みリクエストを受け取り、SSE イベント（progress/result/done/error）を順次送出
 * 2. `pipelineGatewayFactory` で Gateway を作り、`getPipeline` で ref を取得してクローン
 * 3. per-request の `PipelineAnalysisExecutor` を `serviceFactory.create` で生成
 * 4. `PipelineAnalysisService.analyze(...)` に workflow 進捗コールバックを渡して実行
 * 5. 最終結果を `PipelineReportApiResponse` として SSE で送信
 * 6. finally で CloneManager cleanup（ArtifactCacheManager は service 側で finally cleanup する）
 */
export function createPipelineReportHandler(deps: PipelineReportHandlerDeps) {
  return async (
    request: PipelineReportRequest,
    stream: SSEStreamingApi,
    context: PipelineReportHandlerContext,
  ): Promise<void> => {
    const logger = getLogger();
    const state: { cleanup: (() => Promise<void>) | null } = { cleanup: null };
    const projectIdStr = String(request.projectId);

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
      feature: 'pipeline-report',
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
    deps.rateLimiter.registerProject(projectIdStr);

    // keepalive（30秒ごと）
    const keepaliveInterval = setInterval(async () => {
      try {
        await stream.writeSSE({ event: 'keepalive', data: '{}' });
      } catch {
        // ストリームが閉じられた場合は無視
      }
    }, 30_000);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const analysisPromise = async (): Promise<void> => {
        // 1. 開始通知
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({
            status: 'started',
            message: 'Pipeline report analysis started',
          }),
        });

        // 2. 設定オブジェクト組み立て（RegExp コンパイル失敗はここで検出される）
        const settings = buildPipelineReportSettings(request.settings);

        // 3. per-request サービス（metaFetcher + executor）を組み立てる
        // metaFetcher は gateway を内部共有する executor と同じインスタンスを使うため、
        // ここで 1 度だけ生成する
        const services = deps.serviceFactory.create(request.gitlabToken, deps.gitlabApiBaseUrl);

        // 4. pipeline メタ情報取得
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({
            status: 'fetching_pipeline',
            message: 'Fetching pipeline metadata',
          }),
        });
        const pipelineMeta = await services.metaFetcher.getPipeline(
          request.projectId,
          request.pipelineId,
        );

        // 5. クローン（ref を source/target の両方に渡す。PipelineGateway の ref はブランチ/タグどちらでもありうる）
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ status: 'cloning', message: 'Cloning repository' }),
        });
        const cloneResult = await deps.cloneManager.clone(
          request.gitlabToken,
          deps.gitlabApiBaseUrl,
          String(request.projectId),
          pipelineMeta.ref,
          pipelineMeta.ref,
          pipelineMeta.sha,
        );
        state.cleanup = cloneResult.cleanup;

        logger.info(
          {
            projectId: request.projectId,
            pipelineId: request.pipelineId,
            projectDir: cloneResult.projectDir,
          },
          'Repository cloned for pipeline-report analysis',
        );

        // 7. 解析フェーズを SSE に流すコールバック
        const onProgress = (event: PipelineAnalysisProgressEvent): void => {
          // Hono の SSE writer は async なので意図的に fire-and-forget で書き込む
          // （ワークフロー側の同期フローをブロックしないためと、バックプレッシャは keepalive と同じ best-effort 方針）
          stream
            .writeSSE({
              event: 'progress',
              data: JSON.stringify({
                status: 'workflow',
                workflow: event,
              }),
            })
            .catch(() => {
              // ストリーム閉鎖時は無視
            });
        };

        // 8. analyze 実行
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ status: 'analyzing', message: 'Executing pipeline analysis' }),
        });
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

        // 9. 結果の SSE 送出
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

        // 結果を永続化（result送信の直前。SSE切断時はGET /jobs/{jobId}で再取得可能）
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

        await stream.writeSSE({
          event: 'result',
          data: JSON.stringify(apiResponse),
        });

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            status: 'completed',
            message: 'Pipeline report analysis completed',
          }),
        });

        logger.info(
          {
            projectId: request.projectId,
            pipelineId: request.pipelineId,
            targetJobCount: analysis.targetJobs.length,
            completenessVerified: analysis.completenessVerified,
          },
          'Pipeline report API analysis completed',
        );
      };

      if (deps.analysisTimeoutMs) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Pipeline analysis timed out after ${deps.analysisTimeoutMs}ms`));
          }, deps.analysisTimeoutMs);
        });
        await Promise.race([analysisPromise(), timeoutPromise]);
      } else {
        await analysisPromise();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'Pipeline report handler error');

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
      deps.rateLimiter.unregisterProject(projectIdStr);
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
