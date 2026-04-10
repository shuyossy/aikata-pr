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

/**
 * GitLab CI/CD id_tokensで発行されるJWTのペイロード型
 *
 * GitLab公式ドキュメントに記載されたクレームのうち、APIサーバーでログ/監査に
 * 利用するものを任意フィールドとして型化する。いずれも検証処理では必須ではなく、
 * 欠落していても401にはしない。
 */
export interface GitLabIdTokenPayload extends JWTPayload {
  /** GitLabログイン名（例: $GITLAB_USER_LOGIN） */
  user_login?: string;
  /** GitLab数値ユーザID */
  user_id?: string | number;
  /** ユーザのメールアドレス */
  user_email?: string;
  /** プロジェクトパス（例: group/project） */
  project_path?: string;
  /** 数値プロジェクトID */
  project_id?: string | number;
  /** 数値名前空間ID */
  namespace_id?: string | number;
  /** 名前空間パス */
  namespace_path?: string;
  /** パイプラインID */
  pipeline_id?: string | number;
  /** ジョブID */
  job_id?: string | number;
  /** ref名 */
  ref?: string;
}

/** JWT認証ミドルウェアがHonoコンテキストにセットする変数の型定義 */
export type JwtAuthEnv = {
  Variables: {
    jwtPayload: GitLabIdTokenPayload;
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
