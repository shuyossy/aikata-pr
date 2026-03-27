import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitLabApiClient } from '../GitLabApiClient.js';

describe('GitLabApiClient', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ヘルパー: 成功レスポンスを生成
  const createOkResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  });

  // ヘルパー: エラーレスポンスを生成
  const createErrorResponse = (status: number, statusText: string) => ({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
  });

  it('GETリクエストにPRIVATE-TOKENヘッダが付与される', async () => {
    const responseData = { id: 1, name: 'test' };
    mockFetch.mockResolvedValueOnce(createOkResponse(responseData));

    const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
    const result = await client.get('/projects/1');

    expect(mockFetch).toHaveBeenCalledWith('https://gitlab.example.com/api/v4/projects/1', {
      headers: { 'PRIVATE-TOKEN': 'test-token' },
    });
    expect(result).toEqual(responseData);
  });

  it('POSTリクエストでbodyがJSON送信される', async () => {
    const requestBody = { body: 'comment text' };
    const responseData = { id: 10, body: 'comment text' };
    mockFetch.mockResolvedValueOnce(createOkResponse(responseData));

    const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
    const result = await client.post('/projects/1/merge_requests/1/notes', requestBody);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/1/merge_requests/1/notes',
      {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': 'test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      },
    );
    expect(result).toEqual(responseData);
  });

  it('HTTPステータス401でエラーがスローされる', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(401, 'Unauthorized'));

    const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'invalid-token');

    await expect(client.get('/projects/1')).rejects.toThrow('GitLab API error: 401 Unauthorized');
  });

  it('HTTPステータス404でエラーがスローされる', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(404, 'Not Found'));

    const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');

    await expect(client.get('/projects/99999')).rejects.toThrow('GitLab API error: 404 Not Found');
  });

  it('POSTリクエストでHTTPエラーの場合、エラーがスローされる', async () => {
    mockFetch.mockResolvedValueOnce(createErrorResponse(500, 'Internal Server Error'));

    const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');

    await expect(
      client.post('/projects/1/merge_requests/1/notes', { body: 'comment' }),
    ).rejects.toThrow('GitLab API error: 500 Internal Server Error');
  });

  it('ベースURLとパスが正しく結合される', async () => {
    mockFetch.mockResolvedValueOnce(createOkResponse({}));

    // 末尾スラッシュ付きのベースURL
    const client = new GitLabApiClient('https://gitlab.example.com/api/v4/', 'test-token');
    await client.get('/projects/1');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/1',
      expect.objectContaining({
        headers: { 'PRIVATE-TOKEN': 'test-token' },
      }),
    );
  });
});
