import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimitCoordinator,
  RateLimitExhaustedError,
  initializeCoordinator,
  getCoordinator,
  resetCoordinator,
} from '../rateLimitCoordinator.js';
import type { RateLimitRetryConfig } from '../rateLimitRetry.js';

const baseConfig: RateLimitRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

describe('RateLimitCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('acquirePermission', () => {
    it('cooldownなしの場合は即座にresolveする', async () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      // cooldown未設定なので即座に完了すること
      await coordinator.acquirePermission();
    });

    it('cooldown中はcooldownUntilまで待機してからresolveす���', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const coordinator = new RateLimitCoordinator(baseConfig);

      coordinator.reportRateLimit();

      let resolved = false;
      const promise = coordinator.acquirePermission().then(() => {
        resolved = true;
      });

      // まだ待機中
      expect(resolved).toBe(false);

      // cooldownが終わるまで時間を進める（attempt=0, jitter=0: 1000ms）
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(resolved).toBe(true);
    });

    it('上限到達時はRateLimitExhaustedErrorをスローする', async () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      // maxRetries(3)回 + 1回reportする → maxRetries回のリトライ後に上限到達
      for (let i = 0; i <= baseConfig.maxRetries; i++) {
        coordinator.reportRateLimit();
      }

      await expect(coordinator.acquirePermission()).rejects.toThrow(RateLimitExhaustedError);
    });

    it('maxRetries回reportではまだ上限に達しない（N回リトライ＝N+1回呼び出し許可）', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const coordinator = new RateLimitCoordinator(baseConfig);

      // maxRetries(3)回report → まだexhaustedではない
      for (let i = 0; i < baseConfig.maxRetries; i++) {
        coordinator.reportRateLimit();
      }

      expect(coordinator.isExhausted()).toBe(false);

      // cooldownを過ぎれば通過できる
      await vi.advanceTimersByTimeAsync(120000);
      await coordinator.acquirePermission();
    });

    it('cooldownなしの場合、上限到達時は即座にRateLimitExhaustedErrorをスローする', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const coordinator = new RateLimitCoordinator(baseConfig);

      for (let i = 0; i <= baseConfig.maxRetries; i++) {
        coordinator.reportRateLimit();
      }

      // cooldownを過ぎた後でもexhausted
      await vi.advanceTimersByTimeAsync(120000);

      await expect(coordinator.acquirePermission()).rejects.toThrow(RateLimitExhaustedError);
    });
  });

  describe('スタガード・リトライ', () => {
    it('cooldown後に複数Agentがスタガー付きで順番に再開する', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const staggerIntervalMs = 200;
      const coordinator = new RateLimitCoordinator(baseConfig, staggerIntervalMs);

      coordinator.reportRateLimit();

      const resolveOrder: number[] = [];

      // 3つのAgentが同時にacquirePermissionを呼ぶ
      const p0 = coordinator.acquirePermission().then(() => resolveOrder.push(0));
      const p1 = coordinator.acquirePermission().then(() => resolveOrder.push(1));
      const p2 = coordinator.acquirePermission().then(() => resolveOrder.push(2));

      // cooldown (1000ms) + スタガー分の時間を進める
      // Agent0: 1000ms後に再開
      // Agent1: 1000ms + 200ms後に再開
      // Agent2: 1000ms + 400ms後に再開
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(staggerIntervalMs);
      await vi.advanceTimersByTimeAsync(staggerIntervalMs);

      await Promise.all([p0, p1, p2]);

      expect(resolveOrder).toEqual([0, 1, 2]);
    });

    it('cooldown中にreportRateLimitが追加で呼ばれた場合、新しいcooldownが適用される', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const coordinator = new RateLimitCoordinator(baseConfig);

      // 1回目のreport: cooldown = 1000ms
      coordinator.reportRateLimit();

      let resolved = false;
      const promise = coordinator.acquirePermission().then(() => {
        resolved = true;
      });

      // 500ms経過
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      // 2回目のreport: cooldown = 2000ms（attempt=1, jitter=0: 1000*2^1=2000）
      coordinator.reportRateLimit();

      // さらに500ms（合計1000ms）: まだ2回目のcooldown中
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      // さらに1500ms（合計2000ms以降）: 2回目のcooldown終了
      await vi.advanceTimersByTimeAsync(1500);
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe('reportRateLimit', () => {
    it('globalRetryCountをインクリメントする', () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      expect(coordinator.retryCount).toBe(0);

      coordinator.reportRateLimit();
      expect(coordinator.retryCount).toBe(1);

      coordinator.reportRateLimit();
      expect(coordinator.retryCount).toBe(2);
    });
  });

  describe('reportSuccess', () => {
    it('globalRetryCountを0にリセットする', () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      coordinator.reportRateLimit();
      coordinator.reportRateLimit();
      expect(coordinator.retryCount).toBe(2);

      coordinator.reportSuccess();
      expect(coordinator.retryCount).toBe(0);
    });

    it('リセット後は再びmaxRetries回までリトライ可能', () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      for (let i = 0; i < baseConfig.maxRetries; i++) {
        coordinator.reportRateLimit();
      }
      expect(coordinator.isExhausted()).toBe(false);

      coordinator.reportSuccess();
      expect(coordinator.retryCount).toBe(0);

      for (let i = 0; i < baseConfig.maxRetries; i++) {
        coordinator.reportRateLimit();
      }
      expect(coordinator.isExhausted()).toBe(false);

      coordinator.reportRateLimit();
      expect(coordinator.isExhausted()).toBe(true);
    });

    it('カウントが0の状態で呼んでも問題ない', () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      expect(coordinator.retryCount).toBe(0);
      coordinator.reportSuccess();
      expect(coordinator.retryCount).toBe(0);
    });
  });

  describe('isExhausted', () => {
    it('globalRetryCount < maxRetriesの場合はfalseを��す', () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      coordinator.reportRateLimit();

      expect(coordinator.isExhausted()).toBe(false);
    });

    it('globalRetryCount > maxRetriesの場合はtrueを返す', () => {
      const coordinator = new RateLimitCoordinator(baseConfig);

      // maxRetries回ではまだfalse
      for (let i = 0; i < baseConfig.maxRetries; i++) {
        coordinator.reportRateLimit();
      }
      expect(coordinator.isExhausted()).toBe(false);

      // maxRetries + 1回でtrue
      coordinator.reportRateLimit();
      expect(coordinator.isExhausted()).toBe(true);
    });
  });
});

describe('シングルトン管理', () => {
  afterEach(() => {
    resetCoordinator();
  });

  it('initializeCoordinatorでインスタンスが生成される', () => {
    const coordinator = initializeCoordinator(baseConfig);

    expect(coordinator).toBeInstanceOf(RateLimitCoordinator);
  });

  it('getCoordinatorで初期化済みインスタンスを取得できる', () => {
    const initialized = initializeCoordinator(baseConfig);
    const retrieved = getCoordinator();

    expect(retrieved).toBe(initialized);
  });

  it('未初期化でgetCoordinatorを呼ぶとエラーをスローする', () => {
    expect(() => getCoordinator()).toThrow(
      'RateLimitCoordinator is not initialized. Call initializeCoordinator() first.',
    );
  });

  it('二重初期化はエラーをスローする', () => {
    initializeCoordinator(baseConfig);

    expect(() => initializeCoordinator(baseConfig)).toThrow(
      'RateLimitCoordinator is already initialized. Call resetCoordinator() before re-initializing.',
    );
  });

  it('resetCoordinator後に再初期化できる', () => {
    initializeCoordinator(baseConfig);
    resetCoordinator();

    const newCoordinator = initializeCoordinator(baseConfig);
    expect(newCoordinator).toBeInstanceOf(RateLimitCoordinator);
  });
});
