import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APICallError } from 'ai';
import {
  isRateLimitError,
  calculateBackoffDelay,
  withRateLimitRetry,
  type RateLimitRetryConfig,
} from '../rateLimitRetry.js';
import { initializeLogger, resetLogger } from '../logger.js';
import { RateLimiter } from '../../infrastructure/adapter/rateLimiter/RateLimiter.js';
import {
  initializeRateLimiter,
  resetRateLimiter,
  RateLimitExhaustedError,
} from '../rateLimiterGlobal.js';

/**
 * テスト用のAPICallErrorを生成するヘルパー
 */
function createAPICallError(options: {
  statusCode?: number;
  responseBody?: string;
  message?: string;
}): APICallError {
  return new APICallError({
    message: options.message ?? 'API call failed',
    url: 'http://test-api/v1/chat',
    requestBodyValues: {},
    statusCode: options.statusCode,
    responseBody: options.responseBody,
    isRetryable: true,
  });
}

describe('isRateLimitError', () => {
  it('statusCode: 429のAPICallErrorでtrueを返す', () => {
    const error = createAPICallError({ statusCode: 429 });

    expect(isRateLimitError(error)).toBe(true);
  });

  it('responseBodyに"rate limit"を含むAPICallErrorでtrueを返す', () => {
    const error = createAPICallError({
      statusCode: 200,
      responseBody: 'You have exceeded the rate limit for this endpoint',
    });

    expect(isRateLimitError(error)).toBe(true);
  });

  it('responseBodyの"Rate Limit"判定は大文字小文字不問', () => {
    const error = createAPICallError({
      statusCode: 200,
      responseBody: 'Rate Limit Exceeded',
    });

    expect(isRateLimitError(error)).toBe(true);
  });

  it('statusCode: 500のAPICallErrorでfalseを返す', () => {
    const error = createAPICallError({ statusCode: 500 });

    expect(isRateLimitError(error)).toBe(false);
  });

  it('APICallError以外のエラーでfalseを返す', () => {
    expect(isRateLimitError(new Error('some error'))).toBe(false);
  });

  it('causeチェーン内の429 APICallErrorでもtrueを返す', () => {
    const apiError = createAPICallError({ statusCode: 429 });
    const wrapper = new Error('Wrapped', { cause: apiError });

    expect(isRateLimitError(wrapper)).toBe(true);
  });

  it('responseBodyがundefinedでstatusCodeも非429の場合はfalseを返す', () => {
    const error = createAPICallError({ statusCode: 400 });

    expect(isRateLimitError(error)).toBe(false);
  });

  it('APICallError.isInstance()でマッチしないがstatusCode=429のErrorでtrueを返す（バージョン不一致フォールバック）', () => {
    const fakeApiError = new Error('Rate limit exceeded') as Error & { statusCode: number };
    fakeApiError.statusCode = 429;

    expect(isRateLimitError(fakeApiError)).toBe(true);
  });

  it('statusCode=429がcauseチェーン内にある場合もフォールバックでtrueを返す', () => {
    const fakeApiError = new Error('Rate limit') as Error & { statusCode: number };
    fakeApiError.statusCode = 429;
    const wrapper = new Error('Wrapped', { cause: fakeApiError });

    expect(isRateLimitError(wrapper)).toBe(true);
  });

  it('フォールバックでstatusCode=500のErrorはfalseを返す', () => {
    const fakeApiError = new Error('Server error') as Error & { statusCode: number };
    fakeApiError.statusCode = 500;

    expect(isRateLimitError(fakeApiError)).toBe(false);
  });
});

describe('calculateBackoffDelay', () => {
  it('attemptに応じて遅延が指数的に増加する', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const delay0 = calculateBackoffDelay(0, 1000, 60000);
    const delay1 = calculateBackoffDelay(1, 1000, 60000);
    const delay2 = calculateBackoffDelay(2, 1000, 60000);

    expect(delay0).toBe(1000);
    expect(delay1).toBe(2000);
    expect(delay2).toBe(4000);

    vi.restoreAllMocks();
  });

  it('maxDelayMsを超えない', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const delay = calculateBackoffDelay(20, 1000, 60000);

    expect(delay).toBeLessThanOrEqual(60000);

    vi.restoreAllMocks();
  });

  it('ジッターが含まれる（ランダム要素あり）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const delay = calculateBackoffDelay(0, 1000, 60000);

    expect(delay).toBe(1500);

    vi.restoreAllMocks();
  });
});

describe('withRateLimitRetry', () => {
  const config: RateLimitRetryConfig = {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    initializeLogger({ userId: 'test-user', level: 'silent' });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
    resetRateLimiter();
    vi.restoreAllMocks();
  });

  it('成功時はリトライせず結果を返す', async () => {
    const callback = vi.fn().mockResolvedValue('success');

    const result = await withRateLimitRetry(callback, config);

    expect(result).toBe('success');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('レート制限エラー発生→リトライ→成功', async () => {
    const rateLimitError = createAPICallError({ statusCode: 429 });
    const callback = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue('success');

    const promise = withRateLimitRetry(callback, config);

    // 1回目のリトライ待機を進める
    await vi.advanceTimersByTimeAsync(config.maxDelayMs);
    // 2回目のリトライ待機を進める
    await vi.advanceTimersByTimeAsync(config.maxDelayMs);

    const result = await promise;

    expect(result).toBe('success');
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('レート制限エラーでmaxRetries到達→元エラーを再スロー', async () => {
    const rateLimitError = createAPICallError({ statusCode: 429 });
    const callback = vi.fn().mockRejectedValue(rateLimitError);

    let caughtError: unknown;
    const promise = withRateLimitRetry(callback, config).catch((e) => {
      caughtError = e;
    });

    // 全リトライ分の待機を進める
    for (let i = 0; i < config.maxRetries; i++) {
      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
    }

    await promise;
    expect(caughtError).toBe(rateLimitError);
    expect(callback).toHaveBeenCalledTimes(config.maxRetries + 1);
  });

  it('レート制限以外のエラーはリトライせず即座に再スロー', async () => {
    const genericError = new Error('Internal server error');
    const callback = vi.fn().mockRejectedValue(genericError);

    await expect(withRateLimitRetry(callback, config)).rejects.toThrow(genericError);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('ロガーにリトライ情報が出力される', async () => {
    resetLogger();
    const logs: string[] = [];
    const stream = {
      write: (chunk: string) => {
        logs.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;
    initializeLogger({ userId: 'test-user', level: 'warn', stream });

    const rateLimitError = createAPICallError({ statusCode: 429 });
    const callback = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

    const promise = withRateLimitRetry(callback, config);
    await vi.advanceTimersByTimeAsync(config.maxDelayMs);
    await promise;

    expect(logs.length).toBeGreaterThan(0);
    const logContent = logs.join('');
    expect(logContent).toContain('Rate limit');
  });

  describe('レートリミッター連携', () => {
    const projectId = 'test-project';

    function initTestRateLimiter(): RateLimiter {
      const limiter = new RateLimiter({
        rateLimitPerMin: 100,
        baseDelayMs: config.baseDelayMs,
        maxDelayMs: config.maxDelayMs,
      });
      initializeRateLimiter(limiter);
      limiter.registerProject(projectId);
      return limiter;
    }

    it('レートリミッター初期化済みの場合、レート制限エラー時にレートリミッターにreportする', async () => {
      initTestRateLimiter();
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const callback = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

      const promise = withRateLimitRetry(callback, config, { projectId });

      // レートリミッターのcooldownが終わるまで待機
      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      await promise;

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('レートリミッター初期化済みの場合、レート制限以外のエラー時もreportSuccessされる', async () => {
      initTestRateLimiter();
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const nonRateLimitError = new Error('Some other error');
      const callback = vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(nonRateLimitError);

      const promise = withRateLimitRetry(callback, config, { projectId }).catch((e) => e);

      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      const caughtError = await promise;

      expect(caughtError).toBe(nonRateLimitError);
    });

    it('レートリミッター初期化済みの場合、ローカルリトライカウンタが上限到達でRateLimitExhaustedErrorをスローする', async () => {
      initTestRateLimiter();
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const callback = vi.fn().mockRejectedValue(rateLimitError);

      let caughtError: unknown;
      const promise = withRateLimitRetry(callback, config, { projectId }).catch((e) => {
        caughtError = e;
      });

      // maxRetries + 1回分の待機を進める
      for (let i = 0; i <= config.maxRetries; i++) {
        await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      }

      await promise;
      expect(caughtError).toBeInstanceOf(RateLimitExhaustedError);
      expect((caughtError as Error).name).toBe('RateLimitExhaustedError');
    });

    it('レートリミッター未初期化の場合は既存のローカルリトライ動作を維持する', async () => {
      // レートリミッターは初期化しない
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const callback = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

      const promise = withRateLimitRetry(callback, config);
      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      const result = await promise;

      expect(result).toBe('success');
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('projectId未指定の場合はローカルリトライ動作を維持する', async () => {
      initTestRateLimiter();
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const callback = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

      // projectIdなしで呼び出し → ローカルリトライ
      const promise = withRateLimitRetry(callback, config);
      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      const result = await promise;

      expect(result).toBe('success');
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('onRateLimitHitコールバックがレート制限リトライごとに呼ばれる', async () => {
      initTestRateLimiter();
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const callback = vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue('success');
      const onRateLimitHit = vi.fn();

      const promise = withRateLimitRetry(callback, config, { projectId, onRateLimitHit });

      // 1回目のリトライ待機
      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      // 2回目のリトライ待機
      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      await promise;

      // 2回のレート制限エラー → 2回呼ばれる
      expect(onRateLimitHit).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('onRateLimitHitはreportRateLimitの後、次のacquirePermissionの前に呼ばれる', async () => {
      const limiter = initTestRateLimiter();
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const callOrder: string[] = [];

      const reportRateLimitSpy = vi.spyOn(limiter, 'reportRateLimit').mockImplementation(() => {
        callOrder.push('reportRateLimit');
      });
      vi.spyOn(limiter, 'acquirePermission').mockImplementation(async () => {
        callOrder.push('acquirePermission');
      });

      const callback = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');
      const onRateLimitHit = vi.fn().mockImplementation(() => {
        callOrder.push('onRateLimitHit');
      });

      await withRateLimitRetry(callback, config, { projectId, onRateLimitHit });

      expect(callOrder).toEqual([
        'acquirePermission', // 初回呼び出し前
        'reportRateLimit', // レート制限エラー検知後
        'onRateLimitHit', // コールバック呼び出し
        'acquirePermission', // リトライ前
      ]);

      reportRateLimitSpy.mockRestore();
    });

    it('onRateLimitHit未指定の場合もエラーなく動作する', async () => {
      initTestRateLimiter();
      const rateLimitError = createAPICallError({ statusCode: 429 });
      const callback = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

      const promise = withRateLimitRetry(callback, config, { projectId });

      await vi.advanceTimersByTimeAsync(config.maxDelayMs);
      const result = await promise;

      expect(result).toBe('success');
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });
});
