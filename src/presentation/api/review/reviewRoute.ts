import { Hono } from 'hono';
import { reviewRequestSchema } from './reviewHandler.js';
import type { ReviewHandlerDeps, ReviewHandlerContext } from './reviewHandler.js';
import { createReviewHandler } from './reviewHandler.js';
import type {
  JwtAuthEnv,
  GitLabIdTokenPayload,
} from '../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../shared/requestIdMiddleware.js';
import { getLogger, runWithLogContext } from '../../../lib/logger.js';

/** クライアント生成のIdempotency-Keyヘッダ名 */
const IDEMPOTENCY_KEY_HEADER = 'X-Idempotency-Key';

/**
 * レビューAPIルートの環境型定義
 *
 * `JwtAuthEnv`と`RequestIdEnv`を合成し、上流ミドルウェアが設定する
 * `jwtPayload`（任意）と`requestId`を参照可能にする
 */
export type ReviewRouteEnv = JwtAuthEnv &
  RequestIdEnv & {
    Variables: {
      reviewHandlerDeps: ReviewHandlerDeps;
    };
  };

/**
 * レビューAPIルートを作成する
 *
 * POST /review エンドポイントを提供し、JSON応答 `{jobId, status, ...}` で返す。
 * 進捗・結果取得は GET /api/v1/jobs/{jobId} のポーリングで行う。
 */
export function createReviewRoute(): Hono<ReviewRouteEnv> {
  const route = new Hono<ReviewRouteEnv>();

  route.post('/review', async (c) => {
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

    const parsed = reviewRequestSchema.safeParse(body);
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
    const deps = c.get('reviewHandlerDeps');
    const handler = createReviewHandler(deps);

    // リクエスト単位のログコンテキストバインディングを構築
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

    // JWT の `user_login` とリクエストボディの `userId` が不一致の場合は警告ログ
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
        { projectId: request.projectId, mrIid: request.mrIid },
        'Review API request received',
      );

      const handlerContext: ReviewHandlerContext = {
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
        logger.error({ err: error }, 'Unhandled error in review handler');
        return c.json({ error: 'Internal server error' }, 500);
      }
    });
  });

  return route;
}
