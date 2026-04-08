import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../RateLimiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // テスト1: レート制限内でAPI呼び出しが即座に許可されること
  it('レート制限内でAPI呼び出しが即座に許可されること', async () => {
    const limiter = new RateLimiter({ rateLimitPerMin: 10 });
    limiter.registerUser('user-a');

    // レート制限内（10回/分）なのでawaitが即座に解決する
    for (let i = 0; i < 10; i++) {
      await limiter.acquirePermission('user-a');
    }
    // 10回全て即座に通過できればOK
  });

  // テスト2: レート制限到達時に次の分まで待機すること
  it('レート制限到達時に次の分まで待機すること', async () => {
    const limiter = new RateLimiter({ rateLimitPerMin: 2 });
    limiter.registerUser('user-a');

    // 2回消費してトークンを使い切る
    await limiter.acquirePermission('user-a');
    await limiter.acquirePermission('user-a');

    // 3回目はトークン切れで待機するはず
    let resolved = false;
    const promise = limiter.acquirePermission('user-a').then(() => {
      resolved = true;
    });

    // まだ解決していない
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);

    // 1分経過でトークンが補充される
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved).toBe(true);

    await promise;
  });

  // テスト3: 2ユーザーがラウンドロビンで公平に発行権を得ること
  it('2ユーザーがラウンドロビンで公平に発行権を得ること', async () => {
    const limiter = new RateLimiter({ rateLimitPerMin: 100 });
    limiter.registerUser('user-a');
    limiter.registerUser('user-b');

    const order: string[] = [];

    // 両ユーザーが同時にacquirePermissionを呼ぶ
    const promiseA1 = limiter.acquirePermission('user-a').then(() => order.push('A'));
    const promiseB1 = limiter.acquirePermission('user-b').then(() => order.push('B'));
    const promiseA2 = limiter.acquirePermission('user-a').then(() => order.push('A'));
    const promiseB2 = limiter.acquirePermission('user-b').then(() => order.push('B'));

    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([promiseA1, promiseB1, promiseA2, promiseB2]);

    // ラウンドロビンでA→B→A→Bの順序
    expect(order).toEqual(['A', 'B', 'A', 'B']);
  });

  // テスト4: 429報告時に全ユーザーが一時停止すること
  it('429報告時に全ユーザーが一時停止すること', async () => {
    const limiter = new RateLimiter({
      rateLimitPerMin: 100,
      baseDelayMs: 1000,
      maxDelayMs: 60000,
    });
    limiter.registerUser('user-a');
    limiter.registerUser('user-b');

    // 429エラーを報告（retryCount=0のバックオフ: baseDelayMs * 2^0 + jitter）
    // Math.randomを固定して予測可能にする
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    limiter.reportRateLimit();

    // 両ユーザーのacquirePermissionが待機状態になる
    let resolvedA = false;
    let resolvedB = false;

    const promiseA = limiter.acquirePermission('user-a').then(() => {
      resolvedA = true;
    });
    const promiseB = limiter.acquirePermission('user-b').then(() => {
      resolvedB = true;
    });

    // バックオフ待機中
    await vi.advanceTimersByTimeAsync(500);
    expect(resolvedA).toBe(false);
    expect(resolvedB).toBe(false);

    // バックオフ終了後（delay = min(1000 * 1 + 500, 60000) = 1500ms）
    await vi.advanceTimersByTimeAsync(1500);
    expect(resolvedA).toBe(true);
    expect(resolvedB).toBe(true);

    await Promise.all([promiseA, promiseB]);

    vi.spyOn(Math, 'random').mockRestore();
  });

  // テスト5: 429後の待機が指数バックオフ + ジッターであること
  it('429後の待機が指数バックオフ + ジッターであること', async () => {
    const limiter = new RateLimiter({
      rateLimitPerMin: 100,
      baseDelayMs: 1000,
      maxDelayMs: 60000,
    });
    limiter.registerUser('user-a');

    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // 1回目の429: delay = min(1000 * 2^0 + 500, 60000) = 1500ms
    limiter.reportRateLimit();

    let resolved = false;
    let promise = limiter.acquirePermission('user-a').then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    await promise;

    // 2回目の429: delay = min(1000 * 2^1 + 500, 60000) = 2500ms
    limiter.reportRateLimit();

    resolved = false;
    promise = limiter.acquirePermission('user-a').then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(2499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    await promise;

    // 3回目の429: delay = min(1000 * 2^2 + 500, 60000) = 4500ms
    limiter.reportRateLimit();

    resolved = false;
    promise = limiter.acquirePermission('user-a').then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(4499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    await promise;

    vi.spyOn(Math, 'random').mockRestore();
  });

  // テスト6: 成功報告でretryCountがリセットされること
  it('成功報告でretryCountがリセットされること', async () => {
    const limiter = new RateLimiter({
      rateLimitPerMin: 100,
      baseDelayMs: 1000,
      maxDelayMs: 60000,
    });
    limiter.registerUser('user-a');

    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // 3回連続429報告でretryCountを3まで上げる
    limiter.reportRateLimit(); // retryCount: 1
    limiter.reportRateLimit(); // retryCount: 2
    limiter.reportRateLimit(); // retryCount: 3

    // cooldownが終わるまで待つ
    await vi.advanceTimersByTimeAsync(60_000);

    // 成功報告でretryCountリセット
    limiter.reportSuccess();

    // 次の429報告はretryCount=0からのバックオフ: 1000 * 2^0 + 500 = 1500ms
    limiter.reportRateLimit();

    let resolved = false;
    const promise = limiter.acquirePermission('user-a').then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    await promise;

    vi.spyOn(Math, 'random').mockRestore();
  });

  // テスト7: ユーザー登録/解除が正しく動作すること
  it('ユーザー登録/解除が正しく動作すること', async () => {
    const limiter = new RateLimiter({ rateLimitPerMin: 100 });

    // 未登録ユーザーのacquirePermissionはエラー
    await expect(limiter.acquirePermission('unknown-user')).rejects.toThrow(
      'User "unknown-user" is not registered',
    );

    // 登録後は成功
    limiter.registerUser('user-a');
    await limiter.acquirePermission('user-a');

    // 解除後はエラー
    limiter.unregisterUser('user-a');
    await expect(limiter.acquirePermission('user-a')).rejects.toThrow(
      'User "user-a" is not registered',
    );

    // 同一ユーザーの重複登録はエラーにならない（冪等）
    limiter.registerUser('user-b');
    limiter.registerUser('user-b');
    await limiter.acquirePermission('user-b');

    // 存在しないユーザーの解除はエラーにならない（冪等）
    limiter.unregisterUser('non-existent');
  });

  // テスト8: 3ユーザーのラウンドロビンが正しく動作すること
  it('3ユーザーのラウンドロビンが正しく動作すること', async () => {
    const limiter = new RateLimiter({ rateLimitPerMin: 100 });
    limiter.registerUser('user-a');
    limiter.registerUser('user-b');
    limiter.registerUser('user-c');

    const order: string[] = [];

    const promiseA1 = limiter.acquirePermission('user-a').then(() => order.push('A'));
    const promiseB1 = limiter.acquirePermission('user-b').then(() => order.push('B'));
    const promiseC1 = limiter.acquirePermission('user-c').then(() => order.push('C'));
    const promiseA2 = limiter.acquirePermission('user-a').then(() => order.push('A'));
    const promiseB2 = limiter.acquirePermission('user-b').then(() => order.push('B'));
    const promiseC2 = limiter.acquirePermission('user-c').then(() => order.push('C'));

    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([promiseA1, promiseB1, promiseC1, promiseA2, promiseB2, promiseC2]);

    // ラウンドロビンでA→B→C→A→B→Cの順序
    expect(order).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
  });

  // テスト9: maxRetriesに達した場合にエラーがスローされること
  it('maxRetriesに達した場合にエラーがスローされること', async () => {
    const limiter = new RateLimiter({
      rateLimitPerMin: 100,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      maxRetries: 3,
    });
    limiter.registerUser('user-a');

    vi.spyOn(Math, 'random').mockReturnValue(0);

    // maxRetries=3なので、3回の報告でretryCount=3、4回目の報告でretryCount=4 > maxRetries
    limiter.reportRateLimit(); // retryCount: 1
    limiter.reportRateLimit(); // retryCount: 2
    limiter.reportRateLimit(); // retryCount: 3

    // cooldownが終わるまで待つ
    await vi.advanceTimersByTimeAsync(60_000);

    // まだmaxRetriesに達していない（retryCount=3 <= maxRetries=3）
    await limiter.acquirePermission('user-a');

    // もう1回報告するとretryCount=4 > maxRetries=3
    limiter.reportRateLimit();

    // cooldownが終わるまで待つ
    await vi.advanceTimersByTimeAsync(60_000);

    // maxRetriesを超えたのでエラー
    await expect(limiter.acquirePermission('user-a')).rejects.toThrow('Rate limit retry exhausted');

    vi.spyOn(Math, 'random').mockRestore();
  });

  // テスト: トークンバケットのリフィルが正しく動作すること
  it('トークンバケットが時間経過で補充されること', async () => {
    const limiter = new RateLimiter({ rateLimitPerMin: 6 });
    limiter.registerUser('user-a');

    // 6トークン全て消費
    for (let i = 0; i < 6; i++) {
      await limiter.acquirePermission('user-a');
    }

    // 10秒後に1トークン補充（6/60秒 = 0.1トークン/秒、10秒で1トークン）
    let resolved = false;
    const promise = limiter.acquirePermission('user-a').then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);

    await promise;
  });

  // テスト: ユーザー解除後もラウンドロビンが正しく継続すること
  it('ユーザー解除後もラウンドロビンが正しく継続すること', async () => {
    const limiter = new RateLimiter({ rateLimitPerMin: 100 });
    limiter.registerUser('user-a');
    limiter.registerUser('user-b');
    limiter.registerUser('user-c');

    // user-bを解除
    limiter.unregisterUser('user-b');

    const order: string[] = [];

    const promiseA1 = limiter.acquirePermission('user-a').then(() => order.push('A'));
    const promiseC1 = limiter.acquirePermission('user-c').then(() => order.push('C'));
    const promiseA2 = limiter.acquirePermission('user-a').then(() => order.push('A'));
    const promiseC2 = limiter.acquirePermission('user-c').then(() => order.push('C'));

    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([promiseA1, promiseC1, promiseA2, promiseC2]);

    // A→C→A→Cの順序
    expect(order).toEqual(['A', 'C', 'A', 'C']);
  });
});
