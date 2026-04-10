import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { reviewRequestSchema } from './reviewHandler.js';
import type { ReviewHandlerDeps } from './reviewHandler.js';
import { createReviewHandler } from './reviewHandler.js';
import type { JwtAuthEnv, GitLabIdTokenPayload } from '../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from './requestIdMiddleware.js';
import { getLogger, runWithLogContext } from '../../lib/logger.js';

/**
 * レビューAPIルートの環境型定義
 * Honoコンテキストで使用する変数の型
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
 * POST /review エンドポイントを提供し、SSEストリームでレビュー進捗と結果を返す
 * reviewHandlerDepsはHonoコンテキストからミドルウェア経由で注入される
 */
export function createReviewRoute(): Hono<ReviewRouteEnv> {
  const route = new Hono<ReviewRouteEnv>();

  route.post('/review', async (c) => {
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
    // - userId: リクエストボディ由来（主ソース、JWT認証スキップモードでも取得可能）
    // - requestId: requestIdMiddlewareで必ず設定済み
    // - gitlab*: JWT認証有効時のみ補助情報として付与
    const requestId = c.get('requestId');
    // JWT認証スキップモード（dev/test）ではjwtPayloadは未設定のためオプショナル扱い
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

    // JWTの`user_login`とリクエストボディの`userId`が不一致の場合は警告ログを出す（監査用）
    // 拒否はしない：JWT無しdevモードとの統一的な挙動維持のため
    if (jwtPayload?.user_login && jwtPayload.user_login !== request.userId) {
      // 警告自体は外側コンテキスト（`bindings`適用前）で出す必要はないが、
      // 警告にも`requestId`/`userId`が付与されるようバインディング適用後に出す
      runWithLogContext(bindings, () => {
        getLogger().warn(
          {
            bodyUserId: request.userId,
            jwtUserLogin: jwtPayload.user_login,
          },
          'userId in request body does not match JWT user_login claim',
        );
      });
    }

    // ログコンテキストを確立した状態でSSEストリームハンドラを実行
    return runWithLogContext(bindings, () =>
      streamSSE(
        c,
        async (stream) => {
          getLogger().info(
            { projectId: request.projectId, mrIid: request.mrIid },
            'Review API request received',
          );
          await handler(request, stream);
        },
        async (error, stream) => {
          // SSEストリーム内の未捕捉エラーハンドリング
          getLogger().error({ err: error }, 'SSE stream error');
          try {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ error: 'Internal server error' }),
            });
          } catch {
            // ストリームへの書き込みに失敗した場合は無視
          }
        },
      ),
    );
  });

  return route;
}
