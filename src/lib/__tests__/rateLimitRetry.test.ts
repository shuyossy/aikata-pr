import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import {
  isRateLimitError,
  calculateBackoffDelay,
  withRateLimitRetry,
  type RateLimitRetryConfig,
} from '../rateLimitRetry.js';
import { initializeLogger, resetLogger } from '../logger.js';

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
    // 異なるバージョンのAPICallErrorをシミュレート（isInstanceでマッチしない）
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
    // Math.randomを固定して検証
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const delay0 = calculateBackoffDelay(0, 1000, 60000);
    const delay1 = calculateBackoffDelay(1, 1000, 60000);
    const delay2 = calculateBackoffDelay(2, 1000, 60000);

    // jitter=0の場合: 1000*2^0=1000, 1000*2^1=2000, 1000*2^2=4000
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
    // random=0.5 の場合: 1000*2^0 + 0.5*1000 = 1500
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
    // テスト用ロガーを初期化
    initializeLogger({ userId: 'test-user', level: 'silent' });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
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
    // 初回 + maxRetries回
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

    // ログが出力されていることを確認
    expect(logs.length).toBeGreaterThan(0);
    const logContent = logs.join('');
    expect(logContent).toContain('Rate limit');
  });
});
