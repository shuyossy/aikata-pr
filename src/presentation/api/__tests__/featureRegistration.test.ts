import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { reviewApiModule } from '../review/index.js';
import type { ReviewHandlerDeps } from '../review/index.js';

describe('reviewApiModule', () => {
  it('/api/v1/review ルートを登録する', async () => {
    const app = new Hono();
    // registerの中ではdepsを使わず、routeのみ登録する仕様
    const fakeDeps = {} as unknown as ReviewHandlerDeps;
    reviewApiModule.register(app as never, fakeDeps);

    // ダミーPOSTを投げてルートの存在を確認（404でないこと）
    const res = await app.request('/api/v1/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // バリデーション失敗 (400) でルートは存在する
    expect(res.status).not.toBe(404);
  });

  it('name が review であること', () => {
    expect(reviewApiModule.name).toBe('review');
  });
});
