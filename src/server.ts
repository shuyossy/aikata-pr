import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createJwtAuthMiddleware } from './infrastructure/adapter/auth/index.js';
import type { JwtAuthEnv } from './infrastructure/adapter/auth/index.js';
import { createReviewRoute } from './presentation/api/index.js';
import type { ReviewRouteEnv } from './presentation/api/index.js';
import type { ReviewHandlerDeps } from './presentation/api/index.js';
import { DefaultPerRequestServiceFactory } from './presentation/api/index.js';
import { CloneManager } from './infrastructure/adapter/clone/CloneManager.js';
import { RateLimiter } from './infrastructure/adapter/rateLimiter/index.js';
import { mastra } from './mastra/index.js';
import { initializeLogger, getLogger } from './lib/logger.js';
import type {
  ReviewWorkflowRunner,
  ReviewWorkflowParams,
  ReviewWorkflowResult,
} from './application/shared/port/workflow/index.js';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRequestContext } from './mastra/requestContext.js';

/**
 * Mastra reviewWorkflowをReviewWorkflowRunnerインターフェースにラップする（API用）
 */
class MastraReviewWorkflowRunner implements ReviewWorkflowRunner {
  async run(params: ReviewWorkflowParams): Promise<ReviewWorkflowResult> {
    const {
      userId,
      aiApiKey,
      aiApiEndpointUrl,
      aiModelName,
      projectDir,
      openaiReasoningEffort,
      ...inputData
    } = params;

    const requestContext = new RequestContext<WorkflowRequestContext>([
      ['userId', userId],
      ['aiApiKey', aiApiKey],
      ['aiApiEndpointUrl', aiApiEndpointUrl],
      ['aiModelName', aiModelName],
      ['projectDir', projectDir],
      ['openaiReasoningEffort', openaiReasoningEffort],
    ]);

    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    if (result.status === 'failed') {
      throw new Error(`Workflow failed: ${result.error?.message ?? 'Unknown error'}`, {
        cause: result.error,
      });
    }

    if (result.status !== 'success') {
      throw new Error(`Workflow ended with unexpected status: ${result.status}`);
    }

    return result.result as ReviewWorkflowResult;
  }
}

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
 * APIサーバーのHonoアプリを組み立てる
 * テスト時にも利用可能なようにapp生成を関数化
 */
export function createApp(deps: ReviewHandlerDeps): Hono<JwtAuthEnv & ReviewRouteEnv> {
  const app = new Hono<JwtAuthEnv & ReviewRouteEnv>();

  // ヘルスチェック（認証不要）
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // JWT認証ミドルウェア
  const jwtJwksUrl = process.env['JWT_JWKS_URL'];
  const jwtAudience = process.env['JWT_AUDIENCE'];
  const jwtIssuer = process.env['JWT_ISSUER'];
  if (jwtJwksUrl && jwtAudience && jwtIssuer) {
    app.use(
      '/api/*',
      createJwtAuthMiddleware({
        jwksUrl: jwtJwksUrl,
        audience: jwtAudience,
        issuer: jwtIssuer,
      }),
    );
  }

  // reviewHandlerDepsをコンテキストに注入するミドルウェア
  app.use('/api/*', async (c, next) => {
    c.set('reviewHandlerDeps', deps);
    await next();
  });

  // レビューAPIルート
  const reviewRoute = createReviewRoute();
  app.route('/api/v1', reviewRoute);

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
  const aiApiKey = requireEnv('AI_API_KEY');
  const aiApiEndpointUrl = requireEnv('AI_API_ENDPOINT_URL');
  const gitlabApiBaseUrl =
    process.env['GITLAB_API_URL'] ?? process.env['CI_API_V4_URL'] ?? 'https://gitlab.com/api/v4';
  const defaultAiModelName = process.env['AI_MODEL_NAME'] ?? 'openai/o4-mini';

  // 共有依存の組み立て
  const cloneManager = new CloneManager();
  const workflowRunner = new MastraReviewWorkflowRunner();
  const serviceFactory = new DefaultPerRequestServiceFactory(workflowRunner);
  const rateLimiter = new RateLimiter({
    rateLimitPerMin: Number(process.env['AI_API_RATE_LIMIT_PER_MIN'] ?? '60'),
  });

  const deps: ReviewHandlerDeps = {
    cloneManager,
    serviceFactory,
    rateLimiter,
    gitlabApiBaseUrl,
    aiApiKey,
    aiApiEndpointUrl,
    defaultAiModelName,
  };

  const app = createApp(deps);

  // サーバー起動
  const port = Number(process.env['API_PORT'] ?? '3000');
  logger.info({ port }, 'Starting API server');

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, 'API server started');
  });
}

// エントリーポイント（直接実行時のみ起動）
startServer().catch((error) => {
  console.error('Failed to start API server:', error);
  process.exit(1);
});
