import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PipelineReportApiClient,
  VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  type PipelineReportApiRequest,
  type PipelineReportApiResult,
} from '../PipelineReportApiClient.js';
import {
  ApiServerConnectionError,
  ApiServerJobNotStartedError,
  type JobResultPollInfo,
} from '../../../httpClient/jobResultPolling.js';

function createJsonResponse(
  body: Record<string, unknown> | string,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function createNonJsonResponse(body: string, status = 200, contentType = 'text/html'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function createErrorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const FAST_RESILIENCE = {
  fetchRetry: { retryCount: 5, baseMs: 1, maxMs: 2 },
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
    onPoll: ReturnType<typeof vi.fn<(info: JobResultPollInfo) => void>>;
    onJobIdReceived: ReturnType<typeof vi.fn<(id: string) => void>>;
    onError: ReturnType<typeof vi.fn<(err: Error) => void>>;
  } {
    return {
      onPoll: vi.fn<(info: JobResultPollInfo) => void>(),
      onJobIdReceived: vi.fn<(id: string) => void>(),
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

  describe('正常系: 即時応答', () => {
    it('既存success応答から payload を即時取得できること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'pipeline-report',
          status: 'success',
          payload: testResult,
        }),
      );
      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('failed応答でonError が呼ばれてエラーがthrowされること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'failed-job',
          feature: 'pipeline-report',
          status: 'failed',
          errorMessage: 'previous failure',
        }),
      );
      const handlers = createHandlers();
      await expect(createClient().run(testRequest, handlers)).rejects.toThrow('previous failure');
      expect(handlers.onError).toHaveBeenCalledTimes(1);
    });
  });

  describe('リクエストヘッダ', () => {
    it('正しいURL/ヘッダー/ボディでfetchが呼ばれること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'pipeline-report',
          status: 'success',
          payload: testResult,
        }),
      );
      await createClient().run(testRequest, createHandlers());
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toBe(`${BASE_URL}/api/v1/pipeline-report`);
      const init = call[1] as { method: string; headers: Record<string, string>; body: string };
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe(`Bearer ${JWT_TOKEN}`);
      expect(init.headers[VERSION_HEADER]).toBe(VERSION);
      expect(init.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(init.headers[REQUEST_ID_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(JSON.parse(init.body).userId).toBe('alice');
    });

    it('jwt が null の場合 Authorization ヘッダが付与されないこと', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'pipeline-report',
          status: 'success',
          payload: testResult,
        }),
      );
      const client = new PipelineReportApiClient({
        baseUrl: BASE_URL,
        jwt: null,
        version: VERSION,
        resilience: FAST_RESILIENCE,
      });
      await client.run(testRequest, createHandlers());
      const init = mockFetch.mock.calls[0]![1] as { headers: Record<string, string> };
      expect(init.headers['Authorization']).toBeUndefined();
    });

    it('リクエストセット内のリトライで同じIdempotency-KeyとX-Request-Idが使われること', async () => {
      const networkError = new TypeError('Network error');
      mockFetch
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'cached-job',
            feature: 'pipeline-report',
            status: 'success',
            payload: testResult,
          }),
        );
      await createClient().run(testRequest, createHandlers());
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(3);
      const idemKeys = calls.map(
        (c) => (c[1] as { headers: Record<string, string> }).headers[IDEMPOTENCY_KEY_HEADER],
      );
      const reqIds = calls.map(
        (c) => (c[1] as { headers: Record<string, string> }).headers[REQUEST_ID_HEADER],
      );
      expect(new Set(idemKeys).size).toBe(1);
      expect(new Set(reqIds).size).toBe(1);
    });
  });

  describe('fetchリトライ', () => {
    it('ネットワークエラー時にリトライして成功すること', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('ECONNREFUSED')).mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'pipeline-report',
          status: 'success',
          payload: testResult,
        }),
      );
      const result = await createClient().run(testRequest, createHandlers());
      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('5xxエラー時にリトライして成功すること', async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(503, 'Service Unavailable'))
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'cached-job',
            feature: 'pipeline-report',
            status: 'success',
            payload: testResult,
          }),
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

    it('4xxエラーはリトライせず即throwされ、onErrorが呼ばれること', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(400, 'Bad Request'));
      const handlers = createHandlers();
      await expect(createClient().run(testRequest, handlers)).rejects.toThrow(
        'Pipeline report API request failed with status 400',
      );
      expect(handlers.onError).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Content-Type 検証', () => {
    it('text/htmlなど非JSONレスポンスでエラーがthrowされること', async () => {
      mockFetch.mockResolvedValueOnce(
        createNonJsonResponse('<html><body>HAProxy stats</body></html>', 200, 'text/html'),
      );
      const handlers = createHandlers();
      await expect(createClient().run(testRequest, handlers)).rejects.toThrow(
        /Unexpected response content-type/,
      );
      expect(handlers.onError).toHaveBeenCalled();
    });
  });

  describe('pending応答→ポーリング', () => {
    it('pending応答後にポーリングで結果取得できること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ jobId: 'job-123', feature: 'pipeline-report', status: 'pending' }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
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
      const pollCall = mockFetch.mock.calls[1]!;
      expect(pollCall[0]).toContain('/api/v1/jobs/job-123');
      expect((pollCall[1] as { method: string }).method).toBe('GET');
    });

    it('ポーリング中にcurrentStepがonPollに渡されること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ jobId: 'job-step', feature: 'pipeline-report', status: 'pending' }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'job-step',
            feature: 'pipeline-report',
            status: 'pending',
            currentStep: 'analyzing',
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:00:00Z',
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'job-step',
            feature: 'pipeline-report',
            status: 'success',
            payload: testResult,
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );
      const handlers = createHandlers();
      const result = await createClient().run(testRequest, handlers);
      expect(result).toEqual(testResult);
      const stepCall = handlers.onPoll.mock.calls.find((c) => c[0].currentStep === 'analyzing');
      expect(stepCall).toBeDefined();
    });

    it('ポーリング中にfailed status が返ればエラーがthrowされること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ jobId: 'job-fail', feature: 'pipeline-report', status: 'pending' }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
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

    it('ポーリングで連続404が続くとApiServerJobNotStartedErrorがthrowされること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'never-started',
            feature: 'pipeline-report',
            status: 'pending',
          }),
        )
        .mockResolvedValue(createJsonResponse({ error: 'Not found' }, 404));
      await expect(createClient().run(testRequest, createHandlers())).rejects.toBeInstanceOf(
        ApiServerJobNotStartedError,
      );
    });
  });

  describe('onJobIdReceived', () => {
    it('CLI生成のjobIdが onJobIdReceived に渡されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'pipeline-report',
          status: 'success',
          payload: testResult,
        }),
      );
      const handlers = createHandlers();
      await createClient().run(testRequest, handlers);
      expect(handlers.onJobIdReceived).toHaveBeenCalledTimes(1);
      expect(handlers.onJobIdReceived.mock.calls[0][0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });
});
