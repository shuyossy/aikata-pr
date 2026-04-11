import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { reviewApiModule } from '../review/index.js';
import type { ReviewRouteEnv } from '../review/reviewRoute.js';
import type { JwtAuthEnv } from '../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../shared/requestIdMiddleware.js';

describe('reviewApiModule', () => {
  it('/api/v1/review ルートを登録する', async () => {
    const app = new Hono<JwtAuthEnv & ReviewRouteEnv & RequestIdEnv>();
    reviewApiModule.register(app);

    // ダミーPOSTを投げてルートの存在を確認（空ボディはzodバリデーション失敗で400）
    const res = await app.request('/api/v1/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('name が review であること', () => {
    expect(reviewApiModule.name).toBe('review');
  });
});
