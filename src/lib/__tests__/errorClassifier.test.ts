import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { classifyError, UNEXPECTED_ERROR_MESSAGE } from '../errorClassifier.js';

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

describe('classifyError', () => {
  it('コンテキスト長エラーの場合、type: context_length を返す', () => {
    const error = createAPICallError({
      statusCode: 400,
      responseBody: 'context_length_exceeded',
      message: 'Context too long',
    });

    const result = classifyError(error);

    expect(result.type).toBe('context_length');
    expect(result.message).toBe('Context too long');
  });

  it('API呼び出しエラー（コンテキスト長以外）の場合、type: api_call を返す', () => {
    const error = createAPICallError({
      statusCode: 500,
      responseBody: 'Internal server error',
      message: 'Server error occurred',
    });

    const result = classifyError(error);

    expect(result.type).toBe('api_call');
    expect(result.message).toBe('Server error occurred');
  });

  it('通常Errorの場合、type: unknown と定型メッセージを返す', () => {
    const error = new Error('Something went wrong');

    const result = classifyError(error);

    expect(result.type).toBe('unknown');
    expect(result.message).toBe(UNEXPECTED_ERROR_MESSAGE);
  });

  it('非Errorオブジェクトの場合、type: unknown を返す', () => {
    const result = classifyError('string error');

    expect(result.type).toBe('unknown');
    expect(result.message).toBe(UNEXPECTED_ERROR_MESSAGE);
  });

  it('nullの場合、type: unknown を返す', () => {
    const result = classifyError(null);

    expect(result.type).toBe('unknown');
    expect(result.message).toBe(UNEXPECTED_ERROR_MESSAGE);
  });

  it('causeチェーン経由のコンテキスト長エラーを正しく分類する', () => {
    const apiError = createAPICallError({
      statusCode: 400,
      responseBody: 'maximum context length exceeded',
      message: 'Too many tokens',
    });
    const wrapper = new Error('Wrapped', { cause: apiError });

    const result = classifyError(wrapper);

    expect(result.type).toBe('context_length');
    // ラッパーErrorのメッセージが返される（classifyErrorはerror.messageを使う）
    expect(result.message).toBe('Wrapped');
  });

  it('causeチェーン経由のAPIエラーを正しく分類する', () => {
    const apiError = createAPICallError({
      statusCode: 403,
      responseBody: 'Forbidden',
      message: 'Access denied',
    });
    const wrapper = new Error('API failed', { cause: apiError });

    const result = classifyError(wrapper);

    expect(result.type).toBe('api_call');
    expect(result.message).toBe('API failed');
  });
});
