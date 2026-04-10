import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { JWK } from 'jose';
import { createJwtAuthMiddleware } from '../JwtAuthMiddleware.js';
import type { JwtAuthEnv } from '../JwtAuthMiddleware.js';

/**
 * JWTAuthMiddleware テスト
 *
 * GitLab CI/CDのid_tokensで発行されるJWTを検証するミドルウェアのテスト。
 * テスト用の鍵ペアを生成し、ローカルでJWKSエンドポイントをモックすることで
 * 外部ネットワークに依存しないテストを実現する。
 */

// テスト用の定数
const TEST_AUDIENCE = 'https://aikata-pr.example.com';
const TEST_ISSUER = 'https://gitlab.example.com';

// テスト用の鍵ペアとJWKS
let privateKey: CryptoKey;
let publicJWK: JWK;
let jwksResponse: { keys: JWK[] };

// テスト用Honoアプリを作成するヘルパー
function createTestApp(jwksUrl: string): Hono<JwtAuthEnv> {
  const app = new Hono<JwtAuthEnv>();
  const middleware = createJwtAuthMiddleware({
    jwksUrl,
    audience: TEST_AUDIENCE,
    issuer: TEST_ISSUER,
  });
  app.use('/protected/*', middleware);
  app.get('/protected/resource', (c) => {
    const payload = c.get('jwtPayload');
    return c.json({ message: 'ok', payload });
  });
  return app;
}

// テスト用JWTを生成するヘルパー
async function createTestJwt(
  options: {
    audience?: string;
    issuer?: string;
    expiresIn?: string;
    signingKey?: CryptoKey;
    subject?: string;
    /** GitLab id_tokens互換のカスタムクレーム */
    customClaims?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const {
    audience = TEST_AUDIENCE,
    issuer = TEST_ISSUER,
    expiresIn = '1h',
    signingKey = privateKey,
    subject = 'test-project',
    customClaims = {},
  } = options;

  let builder = new SignJWT({ sub: subject, ...customClaims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt();

  if (audience) builder = builder.setAudience(audience);
  if (issuer) builder = builder.setIssuer(issuer);
  if (expiresIn) builder = builder.setExpirationTime(expiresIn);

  return builder.sign(signingKey);
}

beforeAll(async () => {
  // テスト用RSA鍵ペアを生成
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey;
  publicJWK = await exportJWK(keyPair.publicKey);
  publicJWK.kid = 'test-key-1';
  publicJWK.use = 'sig';
  publicJWK.alg = 'RS256';

  jwksResponse = { keys: [publicJWK] };
});

describe('JwtAuthMiddleware', () => {
  // テスト内で使用するモックJWKSサーバー
  let originalFetch: typeof globalThis.fetch;
  let jwksUrl: string;

  beforeAll(() => {
    jwksUrl = 'https://gitlab.example.com/oauth/discovery/keys';
    originalFetch = globalThis.fetch;
    // fetch をモックしてJWKSエンドポイントをシミュレート
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(jwksUrl)) {
        return new Response(JSON.stringify(jwksResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('有効なJWTでリクエストが通過し、jwtPayloadがcontextにセットされること', async () => {
    const app = createTestApp(jwksUrl);
    const token = await createTestJwt();

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('ok');
    expect(body.payload).toBeDefined();
    expect(body.payload.sub).toBe('test-project');
    expect(body.payload.iss).toBe(TEST_ISSUER);
    expect(body.payload.aud).toBe(TEST_AUDIENCE);
  });

  it('Authorizationヘッダなしで401エラーが返ること', async () => {
    const app = createTestApp(jwksUrl);

    const res = await app.request('/protected/resource');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Missing or invalid Authorization header');
  });

  it('"Bearer "プレフィックスなしで401エラーが返ること', async () => {
    const app = createTestApp(jwksUrl);
    const token = await createTestJwt();

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Token ${token}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Missing or invalid Authorization header');
  });

  it('無効な署名で401エラーが返ること', async () => {
    const app = createTestApp(jwksUrl);
    // 別の鍵ペアで署名したJWTを使用
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await createTestJwt({ signingKey: otherKey });

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid or expired token');
  });

  it('期限切れJWTで401エラーが返ること', async () => {
    const app = createTestApp(jwksUrl);
    // 過去の時刻で期限切れにする
    const token = await new SignJWT({ sub: 'test-project' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200) // 2時間前
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600) // 1時間前に期限切れ
      .setAudience(TEST_AUDIENCE)
      .setIssuer(TEST_ISSUER)
      .sign(privateKey);

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid or expired token');
  });

  it('audience不一致で401エラーが返ること', async () => {
    const app = createTestApp(jwksUrl);
    const token = await createTestJwt({ audience: 'https://wrong-audience.example.com' });

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid or expired token');
  });

  it('issuer不一致で401エラーが返ること', async () => {
    const app = createTestApp(jwksUrl);
    const token = await createTestJwt({ issuer: 'https://wrong-issuer.example.com' });

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid or expired token');
  });

  it('GitLab id_tokensのカスタムクレーム（user_login等）がpayloadに保持されること', async () => {
    const app = createTestApp(jwksUrl);
    const token = await createTestJwt({
      customClaims: {
        user_login: 'alice',
        user_id: 123,
        user_email: 'alice@example.com',
        project_path: 'group/subgroup/project',
        project_id: 456,
        pipeline_id: 789,
        job_id: 1011,
        ref: 'main',
      },
    });

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.user_login).toBe('alice');
    expect(body.payload.user_id).toBe(123);
    expect(body.payload.user_email).toBe('alice@example.com');
    expect(body.payload.project_path).toBe('group/subgroup/project');
    expect(body.payload.project_id).toBe(456);
    expect(body.payload.pipeline_id).toBe(789);
    expect(body.payload.job_id).toBe(1011);
    expect(body.payload.ref).toBe('main');
  });

  it('カスタムクレームが無くても（最小限のJWT）認証が成功すること', async () => {
    const app = createTestApp(jwksUrl);
    const token = await createTestJwt(); // customClaims未指定

    const res = await app.request('/protected/resource', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.sub).toBe('test-project');
    // GitLab固有フィールドは未定義で問題ない
    expect(body.payload.user_login).toBeUndefined();
    expect(body.payload.user_id).toBeUndefined();
  });
});
