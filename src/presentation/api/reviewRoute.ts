import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { reviewRequestSchema } from './reviewHandler.js';
import type { ReviewHandlerDeps } from './reviewHandler.js';
import { createReviewHandler } from './reviewHandler.js';
import { getLogger } from '../../lib/logger.js';

/**
 * レビューAPIルートの環境型定義
 * Honoコンテキストで使用する変数の型
 */
export type ReviewRouteEnv = {
  Variables: {
    reviewHandlerDeps: ReviewHandlerDeps;
  };
};

/**
 * レビューAPIルートを作成する
 *
 * POST /review エンドポイントを提供し、SSEストリームでレビュー進捗と結果を返す
 * reviewHandlerDepsはHonoコンテキストからミドルウェア経由で注入される
 */
export function createReviewRoute(): Hono<ReviewRouteEnv> {
  const route = new Hono<ReviewRouteEnv>();

  route.post('/review', async (c) => {
    const logger = getLogger();

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

    logger.info(
      { projectId: request.projectId, mrIid: request.mrIid },
      'Review API request received',
    );

    // SSEストリームでレスポンスを返す
    return streamSSE(
      c,
      async (stream) => {
        await handler(request, stream);
      },
      async (error, stream) => {
        // SSEストリーム内の未捕捉エラーハンドリング
        logger.error({ err: error }, 'SSE stream error');
        try {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ error: 'Internal server error' }),
          });
        } catch {
          // ストリームへの書き込みに失敗した場合は無視
        }
      },
    );
  });

  return route;
}
