import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import {
  extractAPICallError,
  findStatusCodeInChain,
  isContextLengthError,
  isApiCallError,
  isImageCountExceededError,
} from '../aiApiError.js';

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

describe('isContextLengthError', () => {
  it.each([
    'maximum context length',
    'tokens_limit_reached',
    'context_length_exceeded',
    'many images',
    'tokens exceed',
  ])('responseBodyに "%s" が含まれる場合trueを返す', (pattern) => {
    const error = createAPICallError({
      statusCode: 400,
      responseBody: `Error: ${pattern} for this model`,
    });

    expect(isContextLengthError(error)).toBe(true);
  });

  it('関係ないresponseBodyの場合falseを返す', () => {
    const error = createAPICallError({
      statusCode: 400,
      responseBody: 'Invalid request format',
    });

    expect(isContextLengthError(error)).toBe(false);
  });

  it('responseBodyがundefinedの場合falseを返す', () => {
    const error = createAPICallError({ statusCode: 400 });

    expect(isContextLengthError(error)).toBe(false);
  });

  it('APICallError以外のエラーの場合falseを返す', () => {
    expect(isContextLengthError(new Error('generic error'))).toBe(false);
  });

  it('nullの場合falseを返す', () => {
    expect(isContextLengthError(null)).toBe(false);
  });

  it('causeチェーン経由でも検出できる', () => {
    const apiError = createAPICallError({
      statusCode: 400,
      responseBody: 'context_length_exceeded',
    });
    const wrapper = new Error('Wrapped', { cause: apiError });

    expect(isContextLengthError(wrapper)).toBe(true);
  });

  it('RetryError経由でも検出できる', () => {
    const apiError = createAPICallError({
      statusCode: 400,
      responseBody: 'maximum context length exceeded',
    });
    const retryLike = createRetryLikeError([apiError]);
    const wrapper = new Error('Wrapped', { cause: retryLike });

    expect(isContextLengthError(wrapper)).toBe(true);
  });
});

describe('isApiCallError', () => {
  it('直接のAPICallErrorの場合trueを返す', () => {
    const error = createAPICallError({ statusCode: 500 });

    expect(isApiCallError(error)).toBe(true);
  });

  it('causeチェーン経由のAPICallErrorの場合trueを返す', () => {
    const apiError = createAPICallError({ statusCode: 500 });
    const wrapper = new Error('Wrapped', { cause: apiError });

    expect(isApiCallError(wrapper)).toBe(true);
  });

  it('通常Errorの場合falseを返す', () => {
    expect(isApiCallError(new Error('generic'))).toBe(false);
  });

  it('nullの場合falseを返す', () => {
    expect(isApiCallError(null)).toBe(false);
  });
});

describe('isImageCountExceededError', () => {
  it('responseBodyに "many images" を含む場合trueを返す', () => {
    const error = createAPICallError({
      statusCode: 400,
      responseBody: 'Too many images in the request',
    });

    expect(isImageCountExceededError(error)).toBe(true);
  });

  it('responseBodyに "context_length_exceeded" と "images" を含む場合trueを返す', () => {
    const error = createAPICallError({
      statusCode: 400,
      responseBody: 'context_length_exceeded: too many images provided',
    });

    expect(isImageCountExceededError(error)).toBe(true);
  });

  it('responseBodyに "context_length_exceeded" のみで "images" がない場合falseを返す', () => {
    const error = createAPICallError({
      statusCode: 400,
      responseBody: 'context_length_exceeded',
    });

    expect(isImageCountExceededError(error)).toBe(false);
  });

  it('コンテキスト長エラーでないが "images" を含む場合falseを返す', () => {
    const error = createAPICallError({
      statusCode: 400,
      responseBody: 'invalid images format',
    });

    expect(isImageCountExceededError(error)).toBe(false);
  });

  it('APICallErrorでない場合falseを返す', () => {
    expect(isImageCountExceededError(new Error('generic'))).toBe(false);
  });

  it('causeチェーン経由でも検出できる', () => {
    const apiError = createAPICallError({
      statusCode: 400,
      responseBody: 'many images exceeded the limit',
    });
    const wrapper = new Error('Wrapped', { cause: apiError });

    expect(isImageCountExceededError(wrapper)).toBe(true);
  });
});
