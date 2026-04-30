import { Hono } from 'hono';
import { pipelineReportRequestSchema } from './pipelineReportHandler.js';
import type {
  PipelineReportHandlerDeps,
  PipelineReportHandlerContext,
} from './pipelineReportHandler.js';
import { createPipelineReportHandler } from './pipelineReportHandler.js';
import type {
  JwtAuthEnv,
  GitLabIdTokenPayload,
} from '../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../shared/requestIdMiddleware.js';
import { getLogger, runWithLogContext } from '../../../lib/logger.js';

/** クライアント生成のIdempotency-Keyヘッダ名 */
const IDEMPOTENCY_KEY_HEADER = 'X-Idempotency-Key';

/**
 * pipeline-report API ルートの環境型定義
 */
export type PipelineReportRouteEnv = JwtAuthEnv &
  RequestIdEnv & {
    Variables: {
      pipelineReportHandlerDeps: PipelineReportHandlerDeps;
    };
  };

/**
 * pipeline-report API ルートを作成する
 *
 * POST /pipeline-report エンドポイント。JSON応答 `{jobId, status, ...}` を返す。
 * 結果取得は GET /api/v1/jobs/{jobId} ポーリングで行う。
 */
export function createPipelineReportRoute(): Hono<PipelineReportRouteEnv> {
  const route = new Hono<PipelineReportRouteEnv>();

  route.post('/pipeline-report', async (c) => {
    // X-Idempotency-Keyヘッダの取得（必須）
    const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json({ error: `${IDEMPOTENCY_KEY_HEADER} header is required` }, 400);
    }

    // リクエストボディのパースとバリデーション
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = pipelineReportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'Validation error',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        400,
      );
    }

    const request = parsed.data;
    const deps = c.get('pipelineReportHandlerDeps');
    const handler = createPipelineReportHandler(deps);

    const requestId = c.get('requestId');
    const jwtPayload = c.get('jwtPayload') as GitLabIdTokenPayload | undefined;

    const bindings: Record<string, unknown> = {
      requestId,
      userId: request.userId,
    };
    if (jwtPayload) {
      if (jwtPayload.user_id !== undefined) bindings['gitlabUserId'] = jwtPayload.user_id;
      if (jwtPayload.user_email) bindings['gitlabUserEmail'] = jwtPayload.user_email;
      if (jwtPayload.project_path) bindings['gitlabProjectPath'] = jwtPayload.project_path;
      if (jwtPayload.pipeline_id !== undefined)
        bindings['gitlabPipelineId'] = jwtPayload.pipeline_id;
      if (jwtPayload.job_id !== undefined) bindings['gitlabJobId'] = jwtPayload.job_id;
    }

    if (jwtPayload?.user_login && jwtPayload.user_login !== request.userId) {
      runWithLogContext(bindings, () => {
        getLogger().warn(
          { bodyUserId: request.userId, jwtUserLogin: jwtPayload.user_login },
          'userId in request body does not match JWT user_login claim',
        );
      });
    }

    return runWithLogContext(bindings, async () => {
      const logger = getLogger();
      logger.info(
        { projectId: request.projectId, pipelineId: request.pipelineId },
        'Pipeline report API request received',
      );

      const handlerContext: PipelineReportHandlerContext = {
        jobId: requestId,
        idempotencyKey: idempotencyKey.trim(),
        logger,
        logBindings: bindings,
        runWithContext: runWithLogContext,
      };

      try {
        const result = await handler(request, handlerContext);
        return c.json(result.body, result.status);
      } catch (error) {
        logger.error({ err: error }, 'Unhandled error in pipeline-report handler');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
  });

  return route;
}
