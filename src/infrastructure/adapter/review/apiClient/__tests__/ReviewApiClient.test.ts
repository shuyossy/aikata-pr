import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReviewApiClient,
  type ReviewApiRequest,
  type ReviewApiResponse,
  type ReviewProgressEvent,
} from '../ReviewApiClient.js';

/**
 * SSE形式のレスポンスを生成するヘルパー
 */
function createSSEResponse(
  events: Array<{ event: string; data: string }>,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join('');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', ...extraHeaders },
  });
}

/**
 * エラーレスポンスを生成するヘルパー
 */
function createErrorResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    statusText: status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Error',
  });
}

describe('ReviewApiClient', () => {
  const mockFetch = vi.fn();
  const API_URL = 'https://api.example.com';
  const JWT_TOKEN = 'test-jwt-token';

  // テスト用リクエスト
  const testRequest: ReviewApiRequest = {
    userId: 'alice',
    gitlabToken: 'gitlab-token',
    projectId: '123',
    mrIid: '42',
    checklist: ['項目1', '項目2'],
  };

  // テスト用レビュー結果
  const testResult: ReviewApiResponse = {
    results: [
      {
        checkItemContent: '項目1',
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント1',
        isError: false,
      },
      {
        checkItemContent: '項目2',
        ratingLabel: 'B',
        ratingDefinition: '概ね満たしている',
        comment: 'コメント2',
        isError: false,
      },
    ],
    commitHash: 'abc123',
    commitMessage: 'feat: add feature',
    suggestions: [],
    suggestDiscussionIdsToResolve: [],
    baseSha: 'base000',
    headSha: 'head111',
    startSha: 'start222',
  };

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常なSSEレスポンスからレビュー結果を取得できること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify({ status: 'cloning', message: 'Cloning...' }) },
      { event: 'result', data: JSON.stringify(testResult) },
      { event: 'done', data: '{}' },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    const result = await client.executeReview(testRequest);

    expect(result).toEqual(testResult);
  });

  it('progressイベントでonProgressコールバックが呼ばれること', async () => {
    const progressEvents: ReviewProgressEvent[] = [
      { status: 'cloning', message: 'Cloning repository...' },
      { status: 'reviewing', message: 'Reviewing code...' },
    ];
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify(progressEvents[0]) },
      { event: 'progress', data: JSON.stringify(progressEvents[1]) },
      { event: 'result', data: JSON.stringify(testResult) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const onProgress = vi.fn();
    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    await client.executeReview(testRequest, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, progressEvents[0]);
    expect(onProgress).toHaveBeenNthCalledWith(2, progressEvents[1]);
  });

  it('errorイベントでエラーがスローされること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify({ status: 'cloning' }) },
      { event: 'error', data: JSON.stringify({ error: 'Review failed' }) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);

    await expect(client.executeReview(testRequest)).rejects.toThrow(
      'Review API error: Review failed',
    );
  });

  it('keepaliveイベントが無視されること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'keepalive', data: '{}' },
      { event: 'keepalive', data: '{}' },
      { event: 'result', data: JSON.stringify(testResult) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const onProgress = vi.fn();
    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    const result = await client.executeReview(testRequest, onProgress);

    // keepaliveではonProgressが呼ばれない
    expect(onProgress).not.toHaveBeenCalled();
    // resultは正しく返される
    expect(result).toEqual(testResult);
  });

  it('HTTP 400エラーで適切なエラーメッセージが返ること', async () => {
    const errorBody = JSON.stringify({ error: 'Invalid request parameters' });
    mockFetch.mockResolvedValueOnce(createErrorResponse(400, errorBody));

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);

    await expect(client.executeReview(testRequest)).rejects.toThrow(
      `API request failed with status 400: ${errorBody}`,
    );
  });

  it('HTTP 401エラーで適切なエラーメッセージが返ること', async () => {
    const errorBody = JSON.stringify({ error: 'Unauthorized' });
    mockFetch.mockResolvedValueOnce(createErrorResponse(401, errorBody));

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);

    await expect(client.executeReview(testRequest)).rejects.toThrow(
      `API request failed with status 401: ${errorBody}`,
    );
  });

  it('resultイベントなしでストリーム終了時にエラーになること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify({ status: 'cloning' }) },
      { event: 'done', data: '{}' },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);

    await expect(client.executeReview(testRequest)).rejects.toThrow(
      'SSE stream ended without result event',
    );
  });

  it('正しいURL、ヘッダー、ボディでfetchが呼ばれること', async () => {
    const requestWithOptions: ReviewApiRequest = {
      userId: 'alice',
      gitlabToken: 'gitlab-token',
      projectId: '123',
      mrIid: '42',
      checklist: ['項目1'],
      reviewSettings: {
        additionalInstructions: '詳細にレビューしてください',
        concurrentReviewCount: 3,
        commentFormat: '## {title}\n{comment}',
        ratings: [
          { label: 'A', definition: '完全に満たしている' },
          { label: 'B', definition: '概ね満たしている' },
        ],
        hiddenRatingLabels: ['A'],
        qualityGate: {
          failureCriteria: [{ ratingLabel: 'C', threshold: 1 }],
        },
      },
      options: {
        commentLanguage: 'Japanese',
        skillsPaths: ['/path/to/skills'],
        treeMaxDepth: 5,
      },
    };

    const sseResponse = createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    await client.executeReview(requestWithOptions);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(`${API_URL}/api/v1/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
      body: JSON.stringify(requestWithOptions),
    });

    // 送信ボディに userId が含まれる
    const sentBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string) as {
      userId?: string;
    };
    expect(sentBody.userId).toBe('alice');
  });

  it('レスポンスボディが空の場合にエラーがスローされること', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: null,
      headers: new Headers(),
    });

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);

    await expect(client.executeReview(testRequest)).rejects.toThrow('Response body is empty');
  });

  it('errorイベントでメッセージがない場合にUnknown errorが表示されること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'error', data: JSON.stringify({ code: 'UNKNOWN' }) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new ReviewApiClient(API_URL, JWT_TOKEN);

    await expect(client.executeReview(testRequest)).rejects.toThrow(
      'Review API error: Unknown error',
    );
  });

  it('レスポンスヘッダのX-Request-IdがonRequestIdコールバックに渡されること', async () => {
    const sseResponse = createSSEResponse(
      [
        { event: 'progress', data: JSON.stringify({ status: 'cloning' }) },
        { event: 'result', data: JSON.stringify(testResult) },
      ],
      200,
      { 'X-Request-Id': 'server-generated-uuid-123' },
    );
    mockFetch.mockResolvedValueOnce(sseResponse);

    const onRequestId = vi.fn();
    const onProgress = vi.fn();
    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    await client.executeReview(testRequest, onProgress, onRequestId);

    expect(onRequestId).toHaveBeenCalledTimes(1);
    expect(onRequestId).toHaveBeenCalledWith('server-generated-uuid-123');
  });

  it('X-Request-Idが無いレスポンスではonRequestIdが呼ばれないこと', async () => {
    const sseResponse = createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const onRequestId = vi.fn();
    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    await client.executeReview(testRequest, undefined, onRequestId);

    expect(onRequestId).not.toHaveBeenCalled();
  });

  it('onRequestIdがSSEストリーム消費開始前（progress受信前）に呼ばれること', async () => {
    const sseResponse = createSSEResponse(
      [
        { event: 'progress', data: JSON.stringify({ status: 'cloning' }) },
        { event: 'result', data: JSON.stringify(testResult) },
      ],
      200,
      { 'X-Request-Id': 'req-abc' },
    );
    mockFetch.mockResolvedValueOnce(sseResponse);

    const callOrder: string[] = [];
    const onRequestId = vi.fn((id: string) => callOrder.push(`onRequestId:${id}`));
    const onProgress = vi.fn((event: ReviewProgressEvent) =>
      callOrder.push(`onProgress:${event.status}`),
    );
    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    await client.executeReview(testRequest, onProgress, onRequestId);

    // onRequestIdが必ず最初に呼ばれること
    expect(callOrder[0]).toBe('onRequestId:req-abc');
    expect(callOrder).toContain('onProgress:cloning');
  });

  it('HTTPエラー応答にX-Request-Idが含まれる場合もonRequestIdが呼ばれること', async () => {
    const errorResponse = new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'X-Request-Id': 'req-on-error' },
    });
    mockFetch.mockResolvedValueOnce(errorResponse);

    const onRequestId = vi.fn();
    const client = new ReviewApiClient(API_URL, JWT_TOKEN);

    await expect(client.executeReview(testRequest, undefined, onRequestId)).rejects.toThrow(
      /API request failed with status 500/,
    );
    expect(onRequestId).toHaveBeenCalledWith('req-on-error');
  });

  it('チャンク分割されたSSEストリームを正しくパースできること', async () => {
    // SSEデータを複数チャンクに分割してストリーミング
    const chunk1 = 'event: progress\ndata: {"status":"cloning"}\n\neve';
    const chunk2 = 'nt: result\ndata: ' + JSON.stringify(testResult) + '\n\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk1));
        controller.enqueue(new TextEncoder().encode(chunk2));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const onProgress = vi.fn();
    const client = new ReviewApiClient(API_URL, JWT_TOKEN);
    const result = await client.executeReview(testRequest, onProgress);

    expect(onProgress).toHaveBeenCalledWith({ status: 'cloning' });
    expect(result).toEqual(testResult);
  });
});
