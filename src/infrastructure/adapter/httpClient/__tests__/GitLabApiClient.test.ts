import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitLabApiClient } from '../GitLabApiClient.js';

describe('GitLabApiClient', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
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

  describe('getText', () => {
    // ヘルパー: 成功テキストレスポンスを生成
    const createOkTextResponse = (body: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(body),
    });

    it('テキストレスポンスをそのまま返し、PRIVATE-TOKENヘッダが付与される', async () => {
      const traceBody = 'Running job...\nStep 1 passed\nStep 2 passed\n';
      mockFetch.mockResolvedValueOnce(createOkTextResponse(traceBody));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
      const result = await client.getText('/projects/1/jobs/42/trace');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/1/jobs/42/trace',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
      expect(result).toBe(traceBody);
    });

    it('HTTPステータス404でエラーがスローされる（getと同じ文言）', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(404, 'Not Found'));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');

      await expect(client.getText('/projects/1/jobs/9999/trace')).rejects.toThrow(
        'GitLab API error: 404 Not Found',
      );
    });

    it('HTTPステータス500でエラーがスローされる（getと同じ文言）', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(500, 'Internal Server Error'));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');

      await expect(client.getText('/projects/1/jobs/42/trace')).rejects.toThrow(
        'GitLab API error: 500 Internal Server Error',
      );
    });

    it('末尾スラッシュ付きベースURLが正規化される', async () => {
      mockFetch.mockResolvedValueOnce(createOkTextResponse('ok'));

      // 末尾スラッシュ付きのベースURL
      const client = new GitLabApiClient('https://gitlab.example.com/api/v4/', 'test-token');
      await client.getText('/projects/1/jobs/42/trace');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/1/jobs/42/trace',
        expect.objectContaining({
          headers: { 'PRIVATE-TOKEN': 'test-token' },
        }),
      );
    });
  });

  describe('getResponse', () => {
    // ヘルパー: 生 Response オブジェクトを模したレスポンスを生成
    const createOkRawResponse = (body: ReadableStream<Uint8Array> | null, status = 200) => ({
      ok: true,
      status,
      statusText: 'OK',
      body,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/zip' : null),
      },
    });

    it('生のResponseを返し、body/status/headersが保持される', async () => {
      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(createOkRawResponse(webStream));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
      const response = await client.getResponse('/projects/1/jobs/42/artifacts');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/1/jobs/42/artifacts',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
      // status / body / headers がそのまま保持されていること
      expect(response.status).toBe(200);
      expect(response.body).toBe(webStream);
      expect(response.headers.get('content-type')).toBe('application/zip');
    });

    it('HTTPステータス404でエラーがスローされる（getと同じ文言）', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(404, 'Not Found'));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');

      await expect(client.getResponse('/projects/1/jobs/9999/artifacts')).rejects.toThrow(
        'GitLab API error: 404 Not Found',
      );
    });

    it('HTTPステータス403でエラーがスローされる（getと同じ文言）', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(403, 'Forbidden'));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');

      await expect(client.getResponse('/projects/1/jobs/42/artifacts')).rejects.toThrow(
        'GitLab API error: 403 Forbidden',
      );
    });

    it('末尾スラッシュ付きベースURLが正規化される', async () => {
      mockFetch.mockResolvedValueOnce(createOkRawResponse(null));

      // 末尾スラッシュ付きのベースURL
      const client = new GitLabApiClient('https://gitlab.example.com/api/v4/', 'test-token');
      await client.getResponse('/projects/1/jobs/42/artifacts');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/1/jobs/42/artifacts',
        expect.objectContaining({
          headers: { 'PRIVATE-TOKEN': 'test-token' },
        }),
      );
    });
  });

  describe('put', () => {
    it('PUTリクエストでbodyがJSON送信される', async () => {
      const requestBody = { resolved: true };
      const responseData = { id: 'disc-1', resolved: true };
      mockFetch.mockResolvedValueOnce(createOkResponse(responseData));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
      const result = await client.put(
        '/projects/1/merge_requests/1/discussions/disc-1',
        requestBody,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/1/merge_requests/1/discussions/disc-1',
        {
          method: 'PUT',
          headers: {
            'PRIVATE-TOKEN': 'test-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      );
      expect(result).toEqual(responseData);
    });

    it('PUTリクエストでHTTPエラーの場合、エラーがスローされる', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(500, 'Internal Server Error'));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');

      await expect(
        client.put('/projects/1/merge_requests/1/discussions/disc-1', { resolved: true }),
      ).rejects.toThrow('GitLab API error: 500 Internal Server Error');
    });
  });

  describe('getAll', () => {
    // ヘルパー: ページネーション付きレスポンスを生成
    const createPageResponse = (body: unknown, nextUrl?: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      headers: {
        get: (name: string) => {
          if (name === 'link' && nextUrl) {
            return `<${nextUrl}>; rel="next"`;
          }
          return null;
        },
      },
    });

    it('単一ページの場合、全データを返す', async () => {
      mockFetch.mockResolvedValueOnce(createPageResponse([{ id: 1 }, { id: 2 }]));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
      const result = await client.getAll('/projects/1/notes');

      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/1/notes?per_page=100',
        expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'test-token' } }),
      );
    });

    it('複数ページの場合、全ページのデータを結合して返す', async () => {
      const nextUrl = 'https://gitlab.example.com/api/v4/projects/1/notes?per_page=100&page=2';
      mockFetch
        .mockResolvedValueOnce(createPageResponse([{ id: 1 }, { id: 2 }], nextUrl))
        .mockResolvedValueOnce(createPageResponse([{ id: 3 }]));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
      const result = await client.getAll('/projects/1/notes');

      expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // 2回目のリクエストはLinkヘッダのURLを使用
      expect(mockFetch).toHaveBeenCalledWith(
        nextUrl,
        expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'test-token' } }),
      );
    });

    it('クエリパラメータ付きパスの場合、&でper_pageを追加する', async () => {
      mockFetch.mockResolvedValueOnce(createPageResponse([]));

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
      await client.getAll('/projects/1/notes?sort=asc');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/1/notes?sort=asc&per_page=100',
        expect.objectContaining({ headers: { 'PRIVATE-TOKEN': 'test-token' } }),
      );
    });

    it('HTTPエラーの場合、エラーがスローされる', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => null },
      });

      const client = new GitLabApiClient('https://gitlab.example.com/api/v4', 'test-token');
      await expect(client.getAll('/projects/1/notes')).rejects.toThrow(
        'GitLab API error: 403 Forbidden',
      );
    });
  });
});
