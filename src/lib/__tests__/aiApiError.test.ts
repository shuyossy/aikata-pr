import { describe, it, expect } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import { extractAPICallError, findStatusCodeInChain } from '../aiApiError.js';

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

/**
 * テスト用のRetryError的オブジェクトを生成するヘルパー
 * （ダックタイピング: errorsプロパティを持つErrorオブジェクト）
 */
function createRetryLikeError(errors: unknown[]): Error & { errors: unknown[] } {
  const error = new Error('Retry failed') as Error & { errors: unknown[] };
  error.errors = errors;
  return error;
}

describe('extractAPICallError', () => {
  it('直接のAPICallErrorを抽出できる', () => {
    const apiError = createAPICallError({ statusCode: 429 });

    const result = extractAPICallError(apiError);

    expect(result).toBe(apiError);
  });

  it('Error.causeがAPICallErrorの場合に抽出できる', () => {
    const apiError = createAPICallError({ statusCode: 429 });
    const wrapper = new Error('Wrapped error', { cause: apiError });

    const result = extractAPICallError(wrapper);

    expect(result).toBe(apiError);
  });

  it('RetryError的オブジェクト内のAPICallErrorを抽出できる', () => {
    const apiError = createAPICallError({ statusCode: 429 });
    const retryLike = createRetryLikeError([new Error('other'), apiError]);
    const wrapper = new Error('Wrapped', { cause: retryLike });

    const result = extractAPICallError(wrapper);

    expect(result).toBe(apiError);
  });

  it('ネストしたcauseチェーン内のAPICallErrorを抽出できる', () => {
    const apiError = createAPICallError({ statusCode: 500 });
    const inner = new Error('Inner', { cause: apiError });
    const outer = new Error('Outer', { cause: inner });

    const result = extractAPICallError(outer);

    expect(result).toBe(apiError);
  });

  it('APICallError以外のエラーの場合はnullを返す', () => {
    const error = new Error('Generic error');

    const result = extractAPICallError(error);

    expect(result).toBeNull();
  });

  it('nullの場合はnullを返す', () => {
    expect(extractAPICallError(null)).toBeNull();
  });

  it('undefinedの場合はnullを返す', () => {
    expect(extractAPICallError(undefined)).toBeNull();
  });

  it('文字列の場合はnullを返す', () => {
    expect(extractAPICallError('string error')).toBeNull();
  });
});

describe('findStatusCodeInChain', () => {
  it('直接statusCodeを持つErrorから検出できる', () => {
    const error = new Error('API error') as Error & { statusCode: number };
    error.statusCode = 429;

    expect(findStatusCodeInChain(error)).toBe(429);
  });

  it('causeチェーン内のstatusCodeを検出できる', () => {
    const inner = new Error('Inner') as Error & { statusCode: number };
    inner.statusCode = 500;
    const outer = new Error('Outer', { cause: inner });

    expect(findStatusCodeInChain(outer)).toBe(500);
  });

  it('statusCodeがない場合はnullを返す', () => {
    expect(findStatusCodeInChain(new Error('no status'))).toBeNull();
  });

  it('Error以外の場合はnullを返す', () => {
    expect(findStatusCodeInChain('string')).toBeNull();
    expect(findStatusCodeInChain(null)).toBeNull();
    expect(findStatusCodeInChain(undefined)).toBeNull();
  });
});
