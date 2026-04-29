import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PipelineReportApiClient,
  VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  type PipelineReportApiRequest,
  type PipelineReportApiResult,
  type PipelineReportProgressEvent,
} from '../PipelineReportApiClient.js';
import {
  ApiServerConnectionError,
  ApiServerJobNotStartedError,
} from '../../../httpClient/jobResultPolling.js';

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

function createJobResultResponse(status: number, body: Record<string, unknown> | string): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FAST_RESILIENCE = {
  fetchRetry: { retryCount: 5, baseMs: 1, maxMs: 2 },
  sseIdleTimeoutMs: 100,
  pollIntervalMs: 1,
  pollMaxIntervalMs: 2,
  pollTotalTimeoutMs: 1_000,
  pollNotFoundGraceMs: 50,
};

describe('PipelineReportApiClient', () => {
  const mockFetch = vi.fn();
  const BASE_URL = 'https://api.example.com';
  const JWT_TOKEN = 'test-jwt-token';
  const VERSION = '1.2.3';

  const testRequest: PipelineReportApiRequest = {
    userId: 'alice',
    gitlabToken: 'gitlab-token',
    projectId: 123,
    pipelineId: 4567,
    selfJobId: null,
    settings: {
      jobReportFormat: '## {jobName}\n{status}',
      analysisInstructions: null,
      reportRefinementInstructions: null,
      includeJobPatterns: [],
      excludeJobPatterns: [],
    },
    commentLanguage: 'Japanese',
    maxCompletenessRetries: 3,
    skipCompletenessCheck: false,
    skillsRelPaths: [],
    treeMaxDepth: undefined,
  };

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

  function createClient(): PipelineReportApiClient {
    return new PipelineReportApiClient({
      baseUrl: BASE_URL,
      jwt: JWT_TOKEN,
      version: VERSION,
      resilience: FAST_RESILIENCE,
    });
  }

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('正常系: SSEストリーム経由', () => {
    it('SSEレスポンスから最終結果を取得できること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { event: 'progress', data: JSON.stringify({ status: 'started' }) },
          { event: 'result', data: JSON.stringify(testResult) },
          { event: 'done', data: '{}' },
        ]),
      );

      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
    });

    it('progressイベントでonProgressコールバックが呼ばれること', async () => {
      const events: PipelineReportProgressEvent[] = [
        { status: 'fetching_pipeline' },
        { status: 'cloning' },
        { status: 'analyzing' },
      ];
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { event: 'progress', data: JSON.stringify(events[0]) },
          { event: 'progress', data: JSON.stringify(events[1]) },
          { event: 'progress', data: JSON.stringify(events[2]) },
          { event: 'result', data: JSON.stringify(testResult) },
        ]),
      );

      const handlers = createHandlers();
      await createClient().run(testRequest, handlers);
      expect(handlers.onProgress).toHaveBeenCalledTimes(3);
    });

    it('errorイベントでエラーがスローされonErrorが呼ばれること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { event: 'error', data: JSON.stringify({ error: 'Pipeline analysis failed' }) },
        ]),
      );

      const handlers = createHandlers();
      await expect(createClient().run(testRequest, handlers)).rejects.toThrow(
        'Pipeline report API error: Pipeline analysis failed',
      );
      expect(handlers.onError).toHaveBeenCalled();
    });

    it('keepalive イベントが無視されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { event: 'keepalive', data: '{}' },
          { event: 'result', data: JSON.stringify(testResult) },
          { event: 'done', data: '{}' },
        ]),
      );

      const handlers = createHandlers();
      const result = await createClient().run(testRequest, handlers);
      expect(handlers.onProgress).not.toHaveBeenCalled();
      expect(result).toEqual(testResult);
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

      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
    });
  });

  describe('リクエストヘッダ', () => {
    it('JWTありで正しいヘッダ・ボディが送られること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
      );

      await createClient().run(testRequest, createHandlers());

      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toBe(`${BASE_URL}/api/v1/pipeline-report`);
      const init = call[1] as { method: string; headers: Record<string, string>; body: string };
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.headers[VERSION_HEADER]).toBe(VERSION);
      expect(init.headers['Authorization']).toBe(`Bearer ${JWT_TOKEN}`);
      expect(init.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('jwtがnullの場合はAuthorizationヘッダが付与されないこと', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
      );

      const client = new PipelineReportApiClient({
        baseUrl: BASE_URL,
        jwt: null,
        version: VERSION,
        resilience: FAST_RESILIENCE,
      });
      await client.run(testRequest, createHandlers());

      const headers = (mockFetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('リクエストセット内のリトライで同じIdempotency-Keyが使われること', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('Network error'))
        .mockRejectedValueOnce(new TypeError('Network error'))
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
        );

      await createClient().run(testRequest, createHandlers());

      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(3);
      const keys = calls.map(
        (c) => (c[1] as { headers: Record<string, string> }).headers[IDEMPOTENCY_KEY_HEADER],
      );
      expect(keys[0]).toBe(keys[1]);
      expect(keys[1]).toBe(keys[2]);
    });
  });

  describe('fetchリトライ', () => {
    it('ネットワークエラー時にリトライして成功すること', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('ECONNREFUSED'))
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
        );

      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('5xxエラー時にリトライして成功すること', async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(503, 'Service Unavailable'))
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
        );

      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('全リトライ失敗時に ApiServerConnectionError がthrowされること', async () => {
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(createClient().run(testRequest, createHandlers())).rejects.toBeInstanceOf(
        ApiServerConnectionError,
      );
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it('4xxエラーはリトライせず即throwされること', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(400, 'Bad Request'));

      await expect(createClient().run(testRequest, createHandlers())).rejects.toThrow(
        'Pipeline report API request failed with status 400',
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('SSEフォールバックポーリング', () => {
    it('SSEがresult未受信のまま終了 → GET /jobs/{id} で結果取得できること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createSSEResponse(
            [
              { event: 'progress', data: JSON.stringify({ status: 'analyzing' }) },
              { event: 'done', data: '{}' },
            ],
            200,
            { 'X-Request-Id': 'job-123' },
          ),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
            jobId: 'job-123',
            feature: 'pipeline-report',
            status: 'success',
            payload: testResult,
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );

      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
      expect(mockFetch.mock.calls[1]![0]).toContain('/api/v1/jobs/job-123');
    });

    it('duplicated イベント受信時に既存ジョブをポーリングして結果取得できること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createSSEResponse(
            [
              {
                event: 'progress',
                data: JSON.stringify({ status: 'duplicated', existingJobId: 'old-job-456' }),
              },
            ],
            200,
            { 'X-Request-Id': 'job-789' },
          ),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
            jobId: 'old-job-456',
            feature: 'pipeline-report',
            status: 'success',
            payload: testResult,
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );

      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
      expect(mockFetch.mock.calls[1]![0]).toContain('/api/v1/jobs/old-job-456');
    });

    it('ポーリングで連続404が続くとApiServerJobNotStartedErrorがthrowされること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'done', data: '{}' }], 200, {
            'X-Request-Id': 'never-started',
          }),
        )
        .mockResolvedValue(createJobResultResponse(404, { error: 'Not found' }));

      await expect(createClient().run(testRequest, createHandlers())).rejects.toBeInstanceOf(
        ApiServerJobNotStartedError,
      );
    });

    it('jobIdが取得できないままSSE終了した場合、エラーがthrowされること', async () => {
      mockFetch.mockResolvedValueOnce(createSSEResponse([{ event: 'done', data: '{}' }], 200));

      const handlers = createHandlers();
      await expect(createClient().run(testRequest, handlers)).rejects.toThrow(
        /no jobId is available for polling/,
      );
      expect(handlers.onError).toHaveBeenCalled();
    });

    it('ポーリング中にfailed status が返ればエラーがthrowされonErrorが呼ばれること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'done', data: '{}' }], 200, { 'X-Request-Id': 'job-fail' }),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
            jobId: 'job-fail',
            feature: 'pipeline-report',
            status: 'failed',
            errorMessage: 'AI exploded',
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );

      const handlers = createHandlers();
      await expect(createClient().run(testRequest, handlers)).rejects.toThrow('AI exploded');
      expect(handlers.onError).toHaveBeenCalled();
    });
  });

  describe('レスポンスヘッダ', () => {
    it('レスポンスヘッダのX-Request-IdがonRequestIdコールバックに渡されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }], 200, {
          'X-Request-Id': 'server-uuid',
        }),
      );

      const handlers = createHandlers();
      await createClient().run(testRequest, handlers);
      expect(handlers.onRequestId).toHaveBeenCalledWith('server-uuid');
    });

    it('X-Request-Idが無いレスポンスではonRequestIdが呼ばれないこと', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
      );

      const handlers = createHandlers();
      await createClient().run(testRequest, handlers);
      expect(handlers.onRequestId).not.toHaveBeenCalled();
    });
  });

  describe('SSE idle timeout', () => {
    it('SSEイベントが一定時間来ないとフォールバックポーリングへ移行すること', async () => {
      const stream = new ReadableStream({
        start() {
          // データを送らない
        },
      });
      mockFetch
        .mockResolvedValueOnce(
          new Response(stream, {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'X-Request-Id': 'job-idle',
            },
          }),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
            jobId: 'job-idle',
            feature: 'pipeline-report',
            status: 'success',
            payload: testResult,
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );

      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
    });
  });
});
