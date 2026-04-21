import type { MiddlewareHandler } from 'hono';

/** CLI→APIサーバ間のバージョン伝達に使用するHTTPヘッダ名 */
export const VERSION_HEADER = 'X-Aikata-Version';

/**
 * バージョンチェックミドルウェアを作成する
 *
 * - リクエストの `X-Aikata-Version` ヘッダとサーババージョンを比較する
 * - ヘッダ未送信の場合は 400 Bad Request を返す
 * - バージョン不一致の場合は 409 Conflict を返す
 * - 一致する場合は次のミドルウェア/ハンドラに処理を委譲する
 */
export function createVersionCheckMiddleware(serverVersion: string): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header(VERSION_HEADER);
    const clientVersion = incoming?.trim();

    if (!clientVersion || clientVersion.length === 0) {
      return c.json(
        {
          error: `Missing ${VERSION_HEADER} header. Please update your CLI to match the server version.`,
        },
        400,
      );
    }

    if (clientVersion !== serverVersion) {
      return c.json(
        {
          error: `Version mismatch: client=${clientVersion}, server=${serverVersion}. Please align CLI and API server versions.`,
        },
        409,
      );
    }

    await next();
  };
}
