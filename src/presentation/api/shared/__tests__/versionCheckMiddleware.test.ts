import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createVersionCheckMiddleware, VERSION_HEADER } from '../versionCheckMiddleware.js';

/**
 * バージョンチェックミドルウェアのテスト用アプリを作成
 *
 * GET /api/echo はリクエストが通過したことを確認する用
 */
function createTestApp(serverVersion: string): Hono {
  const app = new Hono();
  app.use('/api/*', createVersionCheckMiddleware(serverVersion));
  app.get('/api/echo', (c) => c.json({ ok: true }));
  // ヘルスチェック相当（ミドルウェア適用外）
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}

describe('versionCheckMiddleware', () => {
  const SERVER_VERSION = '1.2.3';

  it('一致するバージョンヘッダの場合はリクエストが通過する', async () => {
    const app = createTestApp(SERVER_VERSION);

    const res = await app.request('/api/echo', {
      headers: { [VERSION_HEADER]: SERVER_VERSION },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('バージョンヘッダ未送信時は400エラーが返る', async () => {
    const app = createTestApp(SERVER_VERSION);

    const res = await app.request('/api/echo');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('X-Aikata-Version');
  });

  it('バージョン不一致時は409エラーが返り、両バージョンが含まれる', async () => {
    const app = createTestApp(SERVER_VERSION);
    const clientVersion = '0.9.0';

    const res = await app.request('/api/echo', {
      headers: { [VERSION_HEADER]: clientVersion },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(clientVersion);
    expect(body.error).toContain(SERVER_VERSION);
  });

  it('空文字のバージョンヘッダは未送信と同じ扱いで400が返る', async () => {
    const app = createTestApp(SERVER_VERSION);

    const res = await app.request('/api/echo', {
      headers: { [VERSION_HEADER]: '' },
    });

    expect(res.status).toBe(400);
  });

  it('空白のみのバージョンヘッダは未送信と同じ扱いで400が返る', async () => {
    const app = createTestApp(SERVER_VERSION);

    const res = await app.request('/api/echo', {
      headers: { [VERSION_HEADER]: '   ' },
    });

    expect(res.status).toBe(400);
  });

  it('前後に空白があるバージョンヘッダはトリムされて比較される', async () => {
    const app = createTestApp(SERVER_VERSION);

    const res = await app.request('/api/echo', {
      headers: { [VERSION_HEADER]: `  ${SERVER_VERSION}  ` },
    });

    expect(res.status).toBe(200);
  });

  it('/api/* 以外のルートにはミドルウェアが適用されない', async () => {
    const app = createTestApp(SERVER_VERSION);

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
