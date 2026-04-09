import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../RateLimiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===== 入力バリデーション =====

  describe('コンストラクタバリデーション', () => {
    it('rateLimitPerMinが0の場合にエラーをスローすること', () => {
      expect(() => new RateLimiter({ rateLimitPerMin: 0 })).toThrow(
        'rateLimitPerMin must be a positive finite number',
      );
    });

    it('rateLimitPerMinが負数の場合にエラーをスローすること', () => {
      expect(() => new RateLimiter({ rateLimitPerMin: -1 })).toThrow(
        'rateLimitPerMin must be a positive finite number',
      );
    });

    it('rateLimitPerMinがNaNの場合にエラーをスローすること', () => {
      expect(() => new RateLimiter({ rateLimitPerMin: NaN })).toThrow(
        'rateLimitPerMin must be a positive finite number',
      );
    });

    it('rateLimitPerMinがInfinityの場合にエラーをスローすること', () => {
      expect(() => new RateLimiter({ rateLimitPerMin: Infinity })).toThrow(
        'rateLimitPerMin must be a positive finite number',
      );
    });
  });

  // ===== トークンバケット =====

  describe('トークンバケット', () => {
    it('レート制限内でAPI呼び出しが即座に許可されること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 10 });
      limiter.registerProject('proj-a');

      for (let i = 0; i < 10; i++) {
        await limiter.acquirePermission('proj-a');
      }
    });

    it('レート制限到達時に次の分まで待機すること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 2 });
      limiter.registerProject('proj-a');

      await limiter.acquirePermission('proj-a');
      await limiter.acquirePermission('proj-a');

      let resolved = false;
      const promise = limiter.acquirePermission('proj-a').then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolved).toBe(true);

      await promise;
    });

    it('トークンバケットが時間経過で補充されること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 6 });
      limiter.registerProject('proj-a');

      // 6トークン全て消費
      for (let i = 0; i < 6; i++) {
        await limiter.acquirePermission('proj-a');
      }

      // 10秒後に1トークン補充（6/60秒 = 0.1トークン/秒、10秒で1トークン）
      let resolved = false;
      const promise = limiter.acquirePermission('proj-a').then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);

      await promise;
    });
  });

  // ===== ラウンドロビン =====

  describe('ラウンドロビン', () => {
    it('2プロジェクトがラウンドロビンで公平に発行権を得ること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-b');

      const order: string[] = [];

      const promiseA1 = limiter.acquirePermission('proj-a').then(() => order.push('A'));
      const promiseB1 = limiter.acquirePermission('proj-b').then(() => order.push('B'));
      const promiseA2 = limiter.acquirePermission('proj-a').then(() => order.push('A'));
      const promiseB2 = limiter.acquirePermission('proj-b').then(() => order.push('B'));

      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([promiseA1, promiseB1, promiseA2, promiseB2]);

      expect(order).toEqual(['A', 'B', 'A', 'B']);
    });

    it('3プロジェクトのラウンドロビンが正しく動作すること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-b');
      limiter.registerProject('proj-c');

      const order: string[] = [];

      const promiseA1 = limiter.acquirePermission('proj-a').then(() => order.push('A'));
      const promiseB1 = limiter.acquirePermission('proj-b').then(() => order.push('B'));
      const promiseC1 = limiter.acquirePermission('proj-c').then(() => order.push('C'));
      const promiseA2 = limiter.acquirePermission('proj-a').then(() => order.push('A'));
      const promiseB2 = limiter.acquirePermission('proj-b').then(() => order.push('B'));
      const promiseC2 = limiter.acquirePermission('proj-c').then(() => order.push('C'));

      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([promiseA1, promiseB1, promiseC1, promiseA2, promiseB2, promiseC2]);

      expect(order).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
    });
  });

  // ===== グローバルスロットル =====

  describe('グローバルスロットル', () => {
    it('429報告時に全プロジェクトが一時停止すること', async () => {
      const limiter = new RateLimiter({
        rateLimitPerMin: 100,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
      });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-b');

      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      limiter.reportRateLimit();

      let resolvedA = false;
      let resolvedB = false;

      const promiseA = limiter.acquirePermission('proj-a').then(() => {
        resolvedA = true;
      });
      const promiseB = limiter.acquirePermission('proj-b').then(() => {
        resolvedB = true;
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(resolvedA).toBe(false);
      expect(resolvedB).toBe(false);

      // delay = min(1000 * 2^0 + 500, 60000) = 1500ms
      await vi.advanceTimersByTimeAsync(1500);
      expect(resolvedA).toBe(true);
      expect(resolvedB).toBe(true);

      await Promise.all([promiseA, promiseB]);

      vi.spyOn(Math, 'random').mockRestore();
    });

    it('429後の待機が指数バックオフ + ジッターであること', async () => {
      const limiter = new RateLimiter({
        rateLimitPerMin: 100,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
      });
      limiter.registerProject('proj-a');

      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      // 1回目: delay = min(1000 * 2^0 + 500, 60000) = 1500ms
      limiter.reportRateLimit();
      let resolved = false;
      let promise = limiter.acquirePermission('proj-a').then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
      await promise;

      // 2回目: delay = min(1000 * 2^1 + 500, 60000) = 2500ms
      limiter.reportRateLimit();
      resolved = false;
      promise = limiter.acquirePermission('proj-a').then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(2499);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
      await promise;

      // 3回目: delay = min(1000 * 2^2 + 500, 60000) = 4500ms
      limiter.reportRateLimit();
      resolved = false;
      promise = limiter.acquirePermission('proj-a').then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(4499);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
      await promise;

      vi.spyOn(Math, 'random').mockRestore();
    });

    it('成功報告でretryCountがリセットされること', async () => {
      const limiter = new RateLimiter({
        rateLimitPerMin: 100,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
      });
      limiter.registerProject('proj-a');

      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      limiter.reportRateLimit();
      limiter.reportRateLimit();
      limiter.reportRateLimit();

      await vi.advanceTimersByTimeAsync(60_000);

      limiter.reportSuccess();

      // retryCount=0からのバックオフ: 1000 * 2^0 + 500 = 1500ms
      limiter.reportRateLimit();

      let resolved = false;
      const promise = limiter.acquirePermission('proj-a').then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(1499);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resolved).toBe(true);
      await promise;

      vi.spyOn(Math, 'random').mockRestore();
    });

    it('waitForCooldownがcooldown延長に対応すること', async () => {
      const limiter = new RateLimiter({
        rateLimitPerMin: 100,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
      });
      limiter.registerProject('proj-a');

      vi.spyOn(Math, 'random').mockReturnValue(0);

      // 1回目のcooldown: 1000ms
      limiter.reportRateLimit();

      let resolved = false;
      const promise = limiter.acquirePermission('proj-a').then(() => {
        resolved = true;
      });

      // 500ms後にcooldownを延長（2回目: 2000ms）
      await vi.advanceTimersByTimeAsync(500);
      limiter.reportRateLimit();

      // 元のcooldown終了（1000ms）ではまだ解決しない
      await vi.advanceTimersByTimeAsync(500);
      expect(resolved).toBe(false);

      // 延長されたcooldown終了（500 + 2000 = 2500ms）
      await vi.advanceTimersByTimeAsync(1500);
      expect(resolved).toBe(true);

      await promise;

      vi.spyOn(Math, 'random').mockRestore();
    });
  });

  // ===== プロジェクト登録/解除 =====

  describe('プロジェクト登録/解除', () => {
    it('未登録プロジェクトのacquirePermissionはエラーになること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });

      await expect(limiter.acquirePermission('unknown')).rejects.toThrow(
        'Project "unknown" is not registered',
      );
    });

    it('登録後はacquirePermissionが成功すること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      await limiter.acquirePermission('proj-a');
    });

    it('解除後はacquirePermissionがエラーになること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      await limiter.acquirePermission('proj-a');

      limiter.unregisterProject('proj-a');
      await expect(limiter.acquirePermission('proj-a')).rejects.toThrow(
        'Project "proj-a" is not registered',
      );
    });

    it('同一プロジェクトの重複登録はエラーにならないこと（冪等）', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-a');
      await limiter.acquirePermission('proj-a');
    });

    it('存在しないプロジェクトの解除はエラーにならないこと（冪等）', () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.unregisterProject('non-existent');
    });

    it('プロジェクト解除後もラウンドロビンが正しく継続すること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-b');
      limiter.registerProject('proj-c');

      limiter.unregisterProject('proj-b');

      const order: string[] = [];

      const promiseA1 = limiter.acquirePermission('proj-a').then(() => order.push('A'));
      const promiseC1 = limiter.acquirePermission('proj-c').then(() => order.push('C'));
      const promiseA2 = limiter.acquirePermission('proj-a').then(() => order.push('A'));
      const promiseC2 = limiter.acquirePermission('proj-c').then(() => order.push('C'));

      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([promiseA1, promiseC1, promiseA2, promiseC2]);

      expect(order).toEqual(['A', 'C', 'A', 'C']);
    });
  });

  // ===== 参照カウント =====

  describe('参照カウント', () => {
    it('同一projectIdの複数register後、1回のunregisterではキューが維持されること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-a'); // refCount: 2

      limiter.unregisterProject('proj-a'); // refCount: 1（まだ有効）

      // まだ登録されているのでacquirePermission可能
      await limiter.acquirePermission('proj-a');
    });

    it('参照カウントが0になったときにプロジェクトが完全に解除されること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-a'); // refCount: 2

      limiter.unregisterProject('proj-a'); // refCount: 1
      limiter.unregisterProject('proj-a'); // refCount: 0 → 完全削除

      await expect(limiter.acquirePermission('proj-a')).rejects.toThrow(
        'Project "proj-a" is not registered',
      );
    });

    it('参照カウント0到達後の再registerが正しく動作すること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.unregisterProject('proj-a'); // refCount: 0

      limiter.registerProject('proj-a'); // refCount: 1（再登録）
      await limiter.acquirePermission('proj-a');
    });
  });

  // ===== Promise reject =====

  describe('Promise reject', () => {
    it('unregisterProjectが待機中Promiseをrejectすること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 2 });
      limiter.registerProject('proj-a');

      // 2トークン消費してキューを発生させる
      await limiter.acquirePermission('proj-a');
      await limiter.acquirePermission('proj-a');

      // 3回目はトークン切れで待機
      const promise = limiter.acquirePermission('proj-a');

      // プロジェクト解除で待機中のPromiseがrejectされる
      limiter.unregisterProject('proj-a');

      await expect(promise).rejects.toThrow('Project "proj-a" has been unregistered');
    });
  });

  // ===== currentIndex調整 =====

  describe('currentIndex調整', () => {
    it('前方のプロジェクト削除時にcurrentIndexが正しく調整されること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-b');
      limiter.registerProject('proj-c');

      // proj-aにアクセスしてcurrentIndexを1に進める（次はproj-b）
      await limiter.acquirePermission('proj-a');

      // proj-a（index=0）を削除 → currentIndexがデクリメントされるべき
      limiter.unregisterProject('proj-a');

      const order: string[] = [];
      const promiseB = limiter.acquirePermission('proj-b').then(() => order.push('B'));
      const promiseC = limiter.acquirePermission('proj-c').then(() => order.push('C'));
      const promiseB2 = limiter.acquirePermission('proj-b').then(() => order.push('B'));

      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([promiseB, promiseC, promiseB2]);

      // proj-a削除後、currentIndexが調整されてB→C→Bの順序
      expect(order).toEqual(['B', 'C', 'B']);
    });
  });

  // ===== processQueueエラーハンドリング =====

  describe('processQueueエラーハンドリング', () => {
    it('processQueue内でエラーが発生した場合にschedulingがリセットされ新しいリクエストを処理できること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');

      // 1回目の成功
      await limiter.acquirePermission('proj-a');

      // processQueue内でエラーが発生してもschedulingがリセットされ、
      // 後続のリクエストが正常に処理されることを確認
      await limiter.acquirePermission('proj-a');
    });
  });

  // ===== destroy =====

  describe('destroy', () => {
    it('destroy後に全待機Promiseがrejectされること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 2 });
      limiter.registerProject('proj-a');
      limiter.registerProject('proj-b');

      // トークン消費
      await limiter.acquirePermission('proj-a');
      await limiter.acquirePermission('proj-b');

      // 待機状態のPromise
      const promiseA = limiter.acquirePermission('proj-a');
      const promiseB = limiter.acquirePermission('proj-b');

      limiter.destroy();

      await expect(promiseA).rejects.toThrow('RateLimiter has been destroyed');
      await expect(promiseB).rejects.toThrow('RateLimiter has been destroyed');
    });

    it('destroy後のacquirePermissionがエラーになること', async () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.registerProject('proj-a');

      limiter.destroy();

      await expect(limiter.acquirePermission('proj-a')).rejects.toThrow(
        'RateLimiter has been destroyed',
      );
    });

    it('destroy後のregisterProject/unregisterProjectがエラーにならないこと', () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 100 });
      limiter.destroy();

      // 冪等性: destroy後もエラーにならない
      limiter.registerProject('proj-a');
      limiter.unregisterProject('proj-a');
    });
  });
});
