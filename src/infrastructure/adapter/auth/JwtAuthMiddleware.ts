import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';

export interface JwtAuthConfig {
  /** GitLabのJWKSエンドポイントURL */
  jwksUrl: string;
  /** 期待するaudience値 */
  audience: string;
  /** 期待するissuer値（GitLabインスタンスURL） */
  issuer: string;
}

/** JWT認証ミドルウェアがHonoコンテキストにセットする変数の型定義 */
export type JwtAuthEnv = {
  Variables: {
    jwtPayload: JWTPayload;
  };
};

/**
 * JWT認証ミドルウェアを作成する
 * GitLab CI/CDのid_tokensで発行されるJWTを検証する
 */
export function createJwtAuthMiddleware(config: JwtAuthConfig): MiddlewareHandler<JwtAuthEnv> {
  const JWKS = createRemoteJWKSet(new URL(config.jwksUrl));

  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        audience: config.audience,
        issuer: config.issuer,
      });
      // JWTペイロードをコンテキストに保存（後続ハンドラで使用可能）
      c.set('jwtPayload', payload);
      await next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  };
}
