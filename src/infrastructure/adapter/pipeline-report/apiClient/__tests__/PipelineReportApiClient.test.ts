import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PipelineReportApiClient,
  type PipelineReportApiRequest,
  type PipelineReportApiResult,
  type PipelineReportProgressEvent,
} from '../PipelineReportApiClient.js';

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
function createErrorResponse(
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    statusText: status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Error',
    headers: extraHeaders,
  });
}

describe('PipelineReportApiClient', () => {
  const mockFetch = vi.fn();
  const BASE_URL = 'https://api.example.com';
  const JWT_TOKEN = 'test-jwt-token';

  // テスト用リクエスト
  const testRequest: PipelineReportApiRequest = {
    userId: 'alice',
    gitlabToken: 'gitlab-token',
    projectId: 123,
    pipelineId: 4567,
    selfJobId: null,
    settings: {
      jobReportFormat: '## {jobName}\n{status}',
      additionalInstructions: null,
      includeJobPatterns: [],
      excludeJobPatterns: [],
    },
    commentLanguage: 'Japanese',
    maxCompletenessRetries: 3,
    skipCompletenessCheck: false,
    skillsRelPaths: [],
    treeMaxDepth: undefined,
  };

  // テスト用結果ペイロード
  const testResult: PipelineReportApiResult = {
    reportContent: '# Pipeline Report\n\n## Job #1\n- status: success\n',
    completenessVerified: true,
    completenessRetries: 0,
    workflowFailed: false,
    targetJobIds: [1, 2, 3],
    pipeline: {
      projectId: 123,
      pipelineId: 4567,
      ref: 'main',
      sha: 'abc123',
      status: 'success',
      webUrl: 'https://gitlab.example.com/foo/bar/-/pipelines/4567',
    },
  };

  function createHandlers(): {
    onProgress: ReturnType<typeof vi.fn<(event: PipelineReportProgressEvent) => void>>;
    onRequestId: ReturnType<typeof vi.fn<(id: string) => void>>;
    onError: ReturnType<typeof vi.fn<(err: Error) => void>>;
  } {
    return {
      onProgress: vi.fn<(event: PipelineReportProgressEvent) => void>(),
      onRequestId: vi.fn<(id: string) => void>(),
      onError: vi.fn<(err: Error) => void>(),
    };
  }

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常なSSEレスポンスから最終結果を取得できること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify({ status: 'started' }) },
      { event: 'result', data: JSON.stringify(testResult) },
      { event: 'done', data: '{}' },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    const result = await client.run(testRequest, createHandlers());

    expect(result).toEqual(testResult);
  });

  it('progressイベントでonProgressコールバックが呼ばれること', async () => {
    const progressEvents: PipelineReportProgressEvent[] = [
      { status: 'fetching_pipeline', message: 'Fetching pipeline metadata' },
      { status: 'cloning', message: 'Cloning repository' },
      { status: 'analyzing', message: 'Executing pipeline analysis' },
    ];
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify(progressEvents[0]) },
      { event: 'progress', data: JSON.stringify(progressEvents[1]) },
      { event: 'progress', data: JSON.stringify(progressEvents[2]) },
      { event: 'result', data: JSON.stringify(testResult) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    await client.run(testRequest, handlers);

    expect(handlers.onProgress).toHaveBeenCalledTimes(3);
    expect(handlers.onProgress).toHaveBeenNthCalledWith(1, progressEvents[0]);
    expect(handlers.onProgress).toHaveBeenNthCalledWith(2, progressEvents[1]);
    expect(handlers.onProgress).toHaveBeenNthCalledWith(3, progressEvents[2]);
  });

  it('workflow詳細進捗も progressイベントとして onProgressに渡ること', async () => {
    const workflowEvent = {
      status: 'workflow',
      workflow: { type: 'retry', reason: 'incomplete', retryCount: 1 },
    };
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify(workflowEvent) },
      { event: 'result', data: JSON.stringify(testResult) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    await client.run(testRequest, handlers);

    expect(handlers.onProgress).toHaveBeenCalledWith(workflowEvent);
  });

  it('errorイベントでエラーがスローされonErrorが呼ばれること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify({ status: 'analyzing' }) },
      { event: 'error', data: JSON.stringify({ error: 'Pipeline analysis failed' }) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow(
      'Pipeline report API error: Pipeline analysis failed',
    );
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect((handlers.onError.mock.calls[0]?.[0] as Error).message).toContain(
      'Pipeline report API error',
    );
  });

  it('keepalive / done イベントが無視されること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'keepalive', data: '{}' },
      { event: 'keepalive', data: '{}' },
      { event: 'result', data: JSON.stringify(testResult) },
      { event: 'done', data: '{}' },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    const result = await client.run(testRequest, handlers);

    expect(handlers.onProgress).not.toHaveBeenCalled();
    expect(result).toEqual(testResult);
  });

  it('HTTP 400エラーで適切なエラーメッセージが返りonErrorが呼ばれること', async () => {
    const errorBody = JSON.stringify({ error: 'Validation error' });
    mockFetch.mockResolvedValueOnce(createErrorResponse(400, errorBody));

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow(
      `Pipeline report API request failed with status 400: ${errorBody}`,
    );
    expect(handlers.onError).toHaveBeenCalled();
  });

  it('HTTP 401エラーで適切なエラーメッセージが返ること', async () => {
    const errorBody = JSON.stringify({ error: 'Unauthorized' });
    mockFetch.mockResolvedValueOnce(createErrorResponse(401, errorBody));

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow(
      `Pipeline report API request failed with status 401: ${errorBody}`,
    );
  });

  it('resultイベントなしでストリーム終了時にエラーになること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'progress', data: JSON.stringify({ status: 'analyzing' }) },
      { event: 'done', data: '{}' },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow(
      'SSE stream ended without result event',
    );
    expect(handlers.onError).toHaveBeenCalled();
  });

  it('正しいURL、ヘッダー、ボディでfetchが呼ばれること（JWTあり）', async () => {
    const sseResponse = createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    await client.run(testRequest, createHandlers());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/api/v1/pipeline-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JWT_TOKEN}`,
      },
      body: JSON.stringify(testRequest),
    });
  });

  it('jwtがnullの場合はAuthorizationヘッダが付与されないこと', async () => {
    const sseResponse = createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: null });
    await client.run(testRequest, createHandlers());

    const call = mockFetch.mock.calls[0]!;
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).toHaveProperty('Content-Type', 'application/json');
  });

  it('レスポンスボディが空の場合にエラーがスローされること', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: null,
      headers: new Headers(),
    });

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow('Response body is empty');
    expect(handlers.onError).toHaveBeenCalled();
  });

  it('errorイベントでメッセージがない場合にUnknown errorが表示されること', async () => {
    const sseResponse = createSSEResponse([
      { event: 'error', data: JSON.stringify({ code: 'INTERNAL' }) },
    ]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow(
      'Pipeline report API error: Unknown error',
    );
  });

  it('レスポンスヘッダのX-Request-IdがonRequestIdコールバックに渡されること', async () => {
    const sseResponse = createSSEResponse(
      [
        { event: 'progress', data: JSON.stringify({ status: 'started' }) },
        { event: 'result', data: JSON.stringify(testResult) },
      ],
      200,
      { 'X-Request-Id': 'server-generated-uuid-123' },
    );
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    await client.run(testRequest, handlers);

    expect(handlers.onRequestId).toHaveBeenCalledTimes(1);
    expect(handlers.onRequestId).toHaveBeenCalledWith('server-generated-uuid-123');
  });

  it('X-Request-Idが無いレスポンスではonRequestIdが呼ばれないこと', async () => {
    const sseResponse = createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    await client.run(testRequest, handlers);

    expect(handlers.onRequestId).not.toHaveBeenCalled();
  });

  it('HTTPエラー応答にX-Request-Idが含まれる場合もonRequestIdが呼ばれること', async () => {
    mockFetch.mockResolvedValueOnce(
      createErrorResponse(500, JSON.stringify({ error: 'Internal error' }), {
        'X-Request-Id': 'req-on-error',
      }),
    );

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow(
      /Pipeline report API request failed with status 500/,
    );
    expect(handlers.onRequestId).toHaveBeenCalledWith('req-on-error');
  });

  it('チャンク分割されたSSEストリームを正しくパースできること', async () => {
    const chunk1 = 'event: progress\ndata: {"status":"started"}\n\neve';
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

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });
    const result = await client.run(testRequest, handlers);

    expect(handlers.onProgress).toHaveBeenCalledWith({ status: 'started' });
    expect(result).toEqual(testResult);
  });

  it('壊れたJSONがSSEデータに含まれる場合にエラーがスローされること', async () => {
    const sseResponse = createSSEResponse([{ event: 'progress', data: '{not-json' }]);
    mockFetch.mockResolvedValueOnce(sseResponse);

    const handlers = createHandlers();
    const client = new PipelineReportApiClient({ baseUrl: BASE_URL, jwt: JWT_TOKEN });

    await expect(client.run(testRequest, handlers)).rejects.toThrow(
      /Failed to parse SSE event data/,
    );
    expect(handlers.onError).toHaveBeenCalled();
  });
});
