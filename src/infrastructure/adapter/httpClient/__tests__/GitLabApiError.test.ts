import { describe, it, expect } from 'vitest';
import { GitLabApiError } from '../GitLabApiError.js';

describe('GitLabApiError', () => {
  it('ステータス・レスポンスボディ・リクエスト情報がプロパティとして保持される', () => {
    const error = new GitLabApiError({
      status: 404,
      statusText: 'Not Found',
      responseBody: '{"message":"404 Project Not Found"}',
      method: 'GET',
      path: '/projects/999',
    });

    expect(error.status).toBe(404);
    expect(error.statusText).toBe('Not Found');
    expect(error.responseBody).toBe('{"message":"404 Project Not Found"}');
    expect(error.method).toBe('GET');
    expect(error.path).toBe('/projects/999');
  });

  it('メッセージにステータス・メソッド・パス・レスポンスボディが含まれる', () => {
    const error = new GitLabApiError({
      status: 404,
      statusText: 'Not Found',
      responseBody: '{"message":"404 Project Not Found"}',
      method: 'GET',
      path: '/projects/999',
    });

    expect(error.message).toContain('404');
    expect(error.message).toContain('Not Found');
    expect(error.message).toContain('GET');
    expect(error.message).toContain('/projects/999');
    expect(error.message).toContain('{"message":"404 Project Not Found"}');
  });

  it('Errorを継承している', () => {
    const error = new GitLabApiError({
      status: 500,
      statusText: 'Internal Server Error',
      responseBody: '',
      method: 'POST',
      path: '/projects/1/merge_requests/1/discussions',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GitLabApiError');
  });

  describe('isServerError', () => {
    it.each([500, 502, 503, 504])('ステータス%iの場合trueを返す', (status) => {
      const error = new GitLabApiError({
        status,
        statusText: 'Server Error',
        responseBody: '',
        method: 'GET',
        path: '/test',
      });

      expect(error.isServerError).toBe(true);
    });

    it.each([400, 401, 403, 404, 422])('ステータス%iの場合falseを返す', (status) => {
      const error = new GitLabApiError({
        status,
        statusText: 'Client Error',
        responseBody: '',
        method: 'GET',
        path: '/test',
      });

      expect(error.isServerError).toBe(false);
    });
  });

  describe('5xxエラー時の誘導メッセージ', () => {
    it('5xxエラーの場合、再実行を促す誘導メッセージがメッセージに含まれる', () => {
      const error = new GitLabApiError({
        status: 500,
        statusText: 'Internal Server Error',
        responseBody: '{"error":"something went wrong"}',
        method: 'POST',
        path: '/projects/1/merge_requests/1/discussions',
      });

      expect(error.message).toContain(
        'This may be a temporary server issue. Please wait a few minutes and re-run the job.',
      );
    });

    it('4xxエラーの場合、誘導メッセージは含まれない', () => {
      const error = new GitLabApiError({
        status: 404,
        statusText: 'Not Found',
        responseBody: '{"message":"404 Not Found"}',
        method: 'GET',
        path: '/projects/999',
      });

      expect(error.message).not.toContain(
        'This may be a temporary server issue. Please wait a few minutes and re-run the job.',
      );
    });
  });

  describe('リクエストボディ', () => {
    it('リクエストボディがプロパティに保持される', () => {
      const reqBody = '{"body":"comment text"}';
      const error = new GitLabApiError({
        status: 500,
        statusText: 'Internal Server Error',
        responseBody: '',
        method: 'POST',
        path: '/projects/1/merge_requests/1/discussions',
        requestBody: reqBody,
      });

      expect(error.requestBody).toBe(reqBody);
    });

    it('リクエストボディがメッセージに含まれる', () => {
      const reqBody = '{"body":"comment text"}';
      const error = new GitLabApiError({
        status: 500,
        statusText: 'Internal Server Error',
        responseBody: '',
        method: 'POST',
        path: '/projects/1/merge_requests/1/discussions',
        requestBody: reqBody,
      });

      expect(error.message).toContain('Request body: {"body":"comment text"}');
    });

    it('リクエストボディが2000文字超の場合、メッセージ内では截断される', () => {
      const reqBody = 'x'.repeat(3000);
      const error = new GitLabApiError({
        status: 422,
        statusText: 'Unprocessable Entity',
        responseBody: '',
        method: 'POST',
        path: '/projects/1/merge_requests/1/discussions',
        requestBody: reqBody,
      });

      expect(error.message).toContain('... [truncated, total 3000 chars]');
      expect(error.message).not.toContain('x'.repeat(3000));
    });

    it('リクエストボディが2000文字超でもプロパティにはフル値が保持される', () => {
      const reqBody = 'y'.repeat(5000);
      const error = new GitLabApiError({
        status: 422,
        statusText: 'Unprocessable Entity',
        responseBody: '',
        method: 'POST',
        path: '/projects/1/merge_requests/1/discussions',
        requestBody: reqBody,
      });

      expect(error.requestBody).toBe(reqBody);
      expect(error.requestBody).toHaveLength(5000);
    });

    it('リクエストボディがちょうど2000文字の場合は截断されない', () => {
      const reqBody = 'z'.repeat(2000);
      const error = new GitLabApiError({
        status: 422,
        statusText: 'Unprocessable Entity',
        responseBody: '',
        method: 'POST',
        path: '/projects/1/merge_requests/1/discussions',
        requestBody: reqBody,
      });

      expect(error.message).toContain('z'.repeat(2000));
      expect(error.message).not.toContain('[truncated');
    });

    it('リクエストボディが未指定の場合はundefinedでメッセージに含まれない', () => {
      const error = new GitLabApiError({
        status: 404,
        statusText: 'Not Found',
        responseBody: '',
        method: 'GET',
        path: '/projects/999',
      });

      expect(error.requestBody).toBeUndefined();
      expect(error.message).not.toContain('Request body');
    });
  });

  it('レスポンスボディが空の場合もエラーが正しく生成される', () => {
    const error = new GitLabApiError({
      status: 500,
      statusText: 'Internal Server Error',
      responseBody: '',
      method: 'GET',
      path: '/test',
    });

    expect(error.status).toBe(500);
    expect(error.responseBody).toBe('');
    expect(error.message).toContain('500');
  });
});
