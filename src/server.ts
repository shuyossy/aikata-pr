import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createJwtAuthMiddleware } from './infrastructure/adapter/auth/index.js';
import type { JwtAuthEnv } from './infrastructure/adapter/auth/index.js';
import {
  createRequestIdMiddleware,
  createVersionCheckMiddleware,
  reviewApiModule,
  pipelineReportApiModule,
  jobResultApiModule,
} from './presentation/api/index.js';
import type {
  ApiFeatureModule,
  JobResultRouteEnv,
  JobResultHandlerDeps,
} from './presentation/api/index.js';
import type {
  ReviewRouteEnv,
  RequestIdEnv,
  PipelineReportRouteEnv,
} from './presentation/api/index.js';
import type { ReviewHandlerDeps, PipelineReportHandlerDeps } from './presentation/api/index.js';
import {
  DefaultPerRequestServiceFactory,
  DefaultPipelineReportServiceFactory,
} from './presentation/api/index.js';
import { CloneManager } from './infrastructure/adapter/clone/CloneManager.js';
import { RateLimiter } from './infrastructure/adapter/rateLimiter/index.js';
import { FileJobResultStore } from './infrastructure/adapter/jobResultStore/index.js';
import type { JobResultStore } from './application/shared/port/jobResultStore/index.js';
import { errWithCause } from 'pino-std-serializers';
import { MastraReviewWorkflowRunner } from './infrastructure/adapter/review/workflow/index.js';
import { MastraPipelineAnalysisWorkflowRunner } from './infrastructure/adapter/pipeline-report/workflow/MastraPipelineAnalysisWorkflowRunner.js';
import { GitLabPipelineGateway } from './infrastructure/adapter/pipeline-report/gateway/GitLabPipelineGateway.js';
import { GitLabApiClient } from './infrastructure/adapter/httpClient/GitLabApiClient.js';
import { LocalProjectTreeGateway } from './infrastructure/adapter/gateway/LocalProjectTreeGateway.js';
import { GptTokenCounter } from './infrastructure/adapter/tokenCounter/index.js';
import { YauzlArtifactArchiveReader } from './application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.js';
import { mastra } from './mastra/index.js';
import { initializeRateLimiter } from './lib/rateLimiterGlobal.js';
import { initializeLogger, getLogger } from './lib/logger.js';

/**
 * 必須環境変数を取得し、未設定の場合はエラーをスローする
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * JWT認証設定
 */
export interface JwtConfig {
  jwksUrl: string;
  audience: string;
  issuer: string;
}

/**
 * APIサーバー全体の依存を束ねた型。
 * 機能モジュールごとに専用 deps を持たせ、createApp 内のミドルウェアで
 * Honoコンテキストに個別に注入する。
 */
export interface ServerDeps {
  review: ReviewHandlerDeps;
  pipelineReport: PipelineReportHandlerDeps;
  jobResult: JobResultHandlerDeps;
}

/**
 * APIサーバーのHonoアプリを組み立てる
 * テスト時にも利用可能なようにapp生成を関数化
 */
export function createApp(
  deps: ServerDeps,
  serverVersion: string,
  jwtConfig?: JwtConfig,
): Hono<JwtAuthEnv & ReviewRouteEnv & PipelineReportRouteEnv & JobResultRouteEnv & RequestIdEnv> {
  const app = new Hono<
    JwtAuthEnv & ReviewRouteEnv & PipelineReportRouteEnv & JobResultRouteEnv & RequestIdEnv
  >();

  // requestIdミドルウェア（全ルートに適用、最前段）
  // X-Request-Idヘッダがあれば継承、無ければUUID v4を生成
  app.use('*', createRequestIdMiddleware());

  // ヘルスチェック（認証不要・バージョンチェック不要）
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // バージョンチェックミドルウェ��（APIルートのみ。requestIdの後に配置し、エラー応答にもrequestIdが付与される）
  app.use('/api/*', createVersionCheckMiddleware(serverVersion));

  // JWT認証ミドルウェア
  if (jwtConfig) {
    app.use(
      '/api/*',
      createJwtAuthMiddleware({
        jwksUrl: jwtConfig.jwksUrl,
        audience: jwtConfig.audience,
        issuer: jwtConfig.issuer,
      }),
    );
  }

  // 機能ごとのハンドラ依存をコンテキストに注入するミドルウェア
  app.use('/api/*', async (c, next) => {
    c.set('reviewHandlerDeps', deps.review);
    c.set('pipelineReportHandlerDeps', deps.pipelineReport);
    c.set('jobResultHandlerDeps', deps.jobResult);
    await next();
  });

  // featureモジュールを配列でloop登録（将来新機能を追加する際はapiFeatures配列に追加するだけ）
  // 各機能は自身が依存する Variables のみを要求するため Hono の Env 型は不変で
  // 交差型に直接代入できない。ApiFeatureModule<Env> として抽象化し cast で登録する。
  type RegisteredEnv = JwtAuthEnv &
    ReviewRouteEnv &
    PipelineReportRouteEnv &
    JobResultRouteEnv &
    RequestIdEnv;
  const apiFeatures: Array<ApiFeatureModule<RegisteredEnv>> = [
    reviewApiModule as unknown as ApiFeatureModule<RegisteredEnv>,
    pipelineReportApiModule as unknown as ApiFeatureModule<RegisteredEnv>,
    jobResultApiModule as unknown as ApiFeatureModule<RegisteredEnv>,
  ];
  apiFeatures.forEach((f) => f.register(app));

  return app;
}

/**
 * APIサーバーを起動する
 */
export async function startServer(): Promise<void> {
  // ロガー初期化
  initializeLogger({
    userId: 'api-server',
    level: (process.env['AIKATA_LOG_LEVEL'] ?? 'info') as string,
  });

  const logger = getLogger();

  // 必須環境変数の取得
  const serverVersion = requireEnv('AIKATA_PR_VERSION');
  const aiApiKey = requireEnv('AI_API_KEY');
  const aiApiEndpointUrl = requireEnv('AI_API_ENDPOINT_URL');
  const gitlabApiBaseUrl =
    process.env['GITLAB_API_URL'] ?? process.env['CI_API_V4_URL'] ?? 'https://gitlab.com/api/v4';
  const defaultAiModelName = process.env['AI_MODEL_NAME'] ?? 'openai/o4-mini';

  // 共有依存の組み立て
  const cloneManager = new CloneManager(
    Number(process.env['CLONE_TIMEOUT_MS'] ?? '300000'),
    Number(process.env['CLONE_MAX_DISK_MB'] ?? '1024'),
    Number(process.env['MAX_CONCURRENT_CLONES'] ?? '5'),
  );
  const workflowRunner = new MastraReviewWorkflowRunner();
  const serviceFactory = new DefaultPerRequestServiceFactory(workflowRunner);
  const rateLimiter = new RateLimiter({
    rateLimitPerMin: Number(process.env['AI_API_RATE_LIMIT_PER_MIN'] ?? '60'),
  });

  // レートリミッターをグローバルシングルトンとして登録（ワークフロー内からアクセス可能にする）
  initializeRateLimiter(rateLimiter);

  // レビュータイムアウト
  const reviewTimeoutMsEnv = process.env['REVIEW_TIMEOUT_MS'];
  const reviewTimeoutMs = reviewTimeoutMsEnv ? Number(reviewTimeoutMsEnv) : undefined;

  const openaiReasoningEffort = process.env['OPENAI_REASONING_EFFORT'] || undefined;

  // MAX_CONTEXT_LENGTHバリデーション
  const maxContextLengthEnv = process.env['MAX_CONTEXT_LENGTH'];
  let maxContextLength: number | undefined;
  if (maxContextLengthEnv) {
    maxContextLength = Number(maxContextLengthEnv);
    if (!Number.isInteger(maxContextLength) || maxContextLength < 1) {
      throw new Error(
        `Invalid MAX_CONTEXT_LENGTH: ${maxContextLengthEnv}. Must be a positive integer.`,
      );
    }
  }

  // ジョブ結果ストア（SSE接続耐性: review / pipeline-report で共有）
  const jobResultStoreDir =
    process.env['JOB_RESULT_STORE_DIR'] ?? join(tmpdir(), 'aikata-pr-job-results');
  const jobResultTtlMs = Number(process.env['JOB_RESULT_TTL_MS'] ?? '86400000');
  const jobResultSweepIntervalMs = Number(process.env['JOB_RESULT_SWEEP_INTERVAL_MS'] ?? '3600000');
  const jobResultStore: JobResultStore = new FileJobResultStore(jobResultStoreDir);
  await (jobResultStore as FileJobResultStore).init();
  logger.info(
    { jobResultStoreDir, jobResultTtlMs, jobResultSweepIntervalMs },
    'Job result store initialized',
  );

  const reviewDeps: ReviewHandlerDeps = {
    cloneManager,
    serviceFactory,
    rateLimiter,
    jobResultStore,
    jobResultTtlMs,
    gitlabApiBaseUrl,
    aiApiKey,
    aiApiEndpointUrl,
    defaultAiModelName,
    openaiReasoningEffort,
    reviewTimeoutMs,
    maxContextLength,
  };

  // pipeline-report 機能の依存組み立て
  // - PipelineGateway は gitlabToken を束縛するためファクトリ経由で毎リクエスト生成
  // - projectTreeGateway / workflowRunner / tokenCounter / archiveReader はステートレスで共有可能
  const pipelineReportMaxArtifactZipMb = Number(
    process.env['PIPELINE_REPORT_MAX_ARTIFACT_ZIP_MB'] ?? '50',
  );
  const pipelineReportTotalArtifactDiskMb = Number(
    process.env['PIPELINE_REPORT_TOTAL_ARTIFACT_DISK_MB'] ?? '500',
  );

  const projectTreeGateway = new LocalProjectTreeGateway();
  const tokenCounter = new GptTokenCounter();
  const archiveReader = new YauzlArtifactArchiveReader();
  const pipelineWorkflowRunner = new MastraPipelineAnalysisWorkflowRunner(mastra);

  const pipelineReportServiceFactory = new DefaultPipelineReportServiceFactory(
    (gitlabToken, apiBase) => new GitLabPipelineGateway(new GitLabApiClient(apiBase, gitlabToken)),
    projectTreeGateway,
    pipelineWorkflowRunner,
    tokenCounter,
    archiveReader,
    {
      maxArtifactZipBytes: pipelineReportMaxArtifactZipMb * 1024 * 1024,
      totalDiskBytes: pipelineReportTotalArtifactDiskMb * 1024 * 1024,
    },
  );

  const pipelineReportDeps: PipelineReportHandlerDeps = {
    cloneManager, // review と共有
    serviceFactory: pipelineReportServiceFactory,
    rateLimiter, // review と共有
    jobResultStore, // review と共有
    jobResultTtlMs,
    gitlabApiBaseUrl,
    aiApiKey,
    aiApiEndpointUrl,
    defaultAiModelName,
    openaiReasoningEffort,
    analysisTimeoutMs: reviewTimeoutMs,
    maxContextLength,
  };

  const jobResultDeps: JobResultHandlerDeps = {
    jobResultStore,
  };

  const deps: ServerDeps = {
    review: reviewDeps,
    pipelineReport: pipelineReportDeps,
    jobResult: jobResultDeps,
  };

  // JWT認証設定の構築
  const jwtJwksUrl = process.env['JWT_JWKS_URL'];
  const jwtAudience = process.env['JWT_AUDIENCE'];
  const jwtIssuer = process.env['JWT_ISSUER'];

  let jwtConfig: JwtConfig | undefined;
  if (jwtJwksUrl && jwtAudience && jwtIssuer) {
    jwtConfig = { jwksUrl: jwtJwksUrl, audience: jwtAudience, issuer: jwtIssuer };
  } else {
    // 本番環境ではJWT認証が必須
    const nodeEnv = process.env['NODE_ENV'] ?? '';
    if (nodeEnv === 'production') {
      throw new Error(
        'JWT authentication is required in production. Set JWT_JWKS_URL, JWT_AUDIENCE, and JWT_ISSUER environment variables.',
      );
    }
    logger.warn(
      'JWT authentication is NOT configured. API routes are unauthenticated. Set JWT_JWKS_URL, JWT_AUDIENCE, and JWT_ISSUER to enable authentication. In this mode, the userId for per-request log context is taken from the request body only.',
    );
  }

  const app = createApp(deps, serverVersion, jwtConfig);

  // サーバー起動
  const port = Number(process.env['API_PORT'] ?? '3000');
  logger.info({ port }, 'Starting API server');

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, 'API server started');
  });

  // ジョブ結果ストアの定期掃除（TTL超過レコード削除）
  const runSweep = (): void => {
    jobResultStore
      .sweepExpired(new Date())
      .then((removed) => {
        if (removed > 0) {
          logger.info({ removed }, 'Job result sweep completed');
        }
      })
      .catch((err) => {
        logger.warn({ err: errWithCause(err as Error) }, 'Job result sweep failed');
      });
  };
  // 起動時に1度実行 + 定期実行
  runSweep();
  const sweepTimer = setInterval(runSweep, jobResultSweepIntervalMs);

  // graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down API server');
    clearInterval(sweepTimer);
    rateLimiter.destroy();
    server.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// 直接実行時（例: npx tsx src/server.ts）にサーバーを起動する
const isDirectExecution =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(process.argv[1] ?? '', 'file://').href;

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
