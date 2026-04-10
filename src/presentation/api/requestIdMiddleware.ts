import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * リクエストIDミドルウェアがHonoコンテキストにセットする変数の型定義
 */
export type RequestIdEnv = {
  Variables: {
    requestId: string;
  };
};

/** リクエストIDを受け渡すHTTPヘッダ名 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * リクエストIDミドルウェアを作成する
 *
 * - 受信リクエストに`X-Request-Id`ヘッダがあればその値を継承する
 * - 無ければUUID v4を新規生成する
 * - Honoコンテキストに`requestId`として格納し、下流ハンドラで利用可能にする
 * - レスポンスヘッダにも`X-Request-Id`として付与し、クライアント側からのログ照合を可能にする
 */
export function createRequestIdMiddleware(): MiddlewareHandler<RequestIdEnv> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    // 上流からのIDがあれば尊重（ただし空文字は無視）、なければUUID v4を生成
    const requestId = incoming && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
    c.set('requestId', requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
  };
}
