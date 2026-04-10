import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRequestIdMiddleware, REQUEST_ID_HEADER } from '../requestIdMiddleware.js';
import type { RequestIdEnv } from '../requestIdMiddleware.js';

/**
 * RequestIdミドルウェアのテスト用アプリを作成
 *
 * GET /echo-id はコンテキスト内のrequestIdをJSONで返す
 */
function createTestApp(): Hono<RequestIdEnv> {
  const app = new Hono<RequestIdEnv>();
  app.use('*', createRequestIdMiddleware());
  app.get('/echo-id', (c) => {
    const requestId = c.get('requestId');
    return c.json({ requestId });
  });
  return app;
}

/** UUID v4の形式を検証する正規表現 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('requestIdMiddleware', () => {
  it('X-Request-Idヘッダ未指定時にUUID v4が自動生成される', async () => {
    const app = createTestApp();

    const res = await app.request('/echo-id');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toMatch(UUID_V4_REGEX);

    // レスポンスヘッダにも同値が付与される
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.requestId);
  });

  it('X-Request-Idヘッダ指定時にその値が継承される', async () => {
    const app = createTestApp();
    const customId = 'my-custom-request-id-123';

    const res = await app.request('/echo-id', {
      headers: { [REQUEST_ID_HEADER]: customId },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(customId);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(customId);
  });

  it('X-Request-Idヘッダが空文字の場合はUUIDが生成される', async () => {
    const app = createTestApp();

    const res = await app.request('/echo-id', {
      headers: { [REQUEST_ID_HEADER]: '' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toMatch(UUID_V4_REGEX);
  });

  it('X-Request-Idヘッダが空白のみの場合はUUIDが生成される', async () => {
    const app = createTestApp();

    const res = await app.request('/echo-id', {
      headers: { [REQUEST_ID_HEADER]: '   ' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toMatch(UUID_V4_REGEX);
  });

  it('複数の独立したリクエストに異なるUUIDが割り当てられる', async () => {
    const app = createTestApp();

    const res1 = await app.request('/echo-id');
    const res2 = await app.request('/echo-id');

    const body1 = (await res1.json()) as { requestId: string };
    const body2 = (await res2.json()) as { requestId: string };

    expect(body1.requestId).toMatch(UUID_V4_REGEX);
    expect(body2.requestId).toMatch(UUID_V4_REGEX);
    expect(body1.requestId).not.toBe(body2.requestId);
  });

  it('前後に空白が含まれるX-Request-Idがトリムされる', async () => {
    const app = createTestApp();
    const customId = 'request-abc';

    const res = await app.request('/echo-id', {
      headers: { [REQUEST_ID_HEADER]: `  ${customId}  ` },
    });

    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(customId);
  });
});
