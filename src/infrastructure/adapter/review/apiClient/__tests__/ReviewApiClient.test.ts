import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReviewApiClient,
  VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  type ReviewApiRequest,
  type ReviewApiResponse,
} from '../ReviewApiClient.js';
import {
  ApiServerConnectionError,
  ApiServerJobNotStartedError,
} from '../../../httpClient/jobResultPolling.js';

/**
 * POST /api/v1/review に対するJSONレスポンスを生成するヘルパー
 */
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

/**
 * テキスト/HTMLレスポンス（プロキシ不正応答などを再現）を生成するヘルパー
 */
function createNonJsonResponse(body: string, status = 200, contentType = 'text/html'): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

/**
 * 4xxエラーレスポンス
 */
function createErrorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

/** リトライ・ポーリング待機を最小化したテスト用設定 */
const FAST_RESILIENCE = {
  fetchRetry: { retryCount: 5, baseMs: 1, maxMs: 2 },
  pollIntervalMs: 1,
  pollMaxIntervalMs: 2,
  pollTotalTimeoutMs: 1_000,
  pollNotFoundGraceMs: 50,
};

describe('ReviewApiClient', () => {
  const mockFetch = vi.fn();
  const API_URL = 'https://api.example.com';
  const JWT_TOKEN = 'test-jwt-token';
  const VERSION = '1.2.3';

  const testRequest: ReviewApiRequest = {
    userId: 'alice',
    gitlabToken: 'gitlab-token',
    projectId: '123',
    mrIid: '42',
    checklist: ['項目1', '項目2'],
  };

  const testResult: ReviewApiResponse = {
    results: [
      {
        checkItemContent: '項目1',
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント1',
        isError: false,
      },
    ],
    commitHash: 'abc123',
    commitMessage: 'feat: add feature',
    suggestions: [],
    suggestResolveEntries: [],
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

  describe('正常系: 即時 success応答', () => {
    it('既存success応答（Idempotency-Keyヒット）から payload を即時取得できること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'review',
          status: 'success',
          payload: testResult,
        }),
      );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest);

      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('failed応答（Idempotency-Keyヒット）でエラーがthrowされること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'failed-job',
          feature: 'review',
          status: 'failed',
          errorMessage: 'previous failure',
        }),
      );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toThrow('previous failure');
    });
  });

  describe('リクエストヘッダ', () => {
    it('正しいURL、ヘッダー、ボディでfetchが呼ばれること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'review',
          status: 'success',
          payload: testResult,
        }),
      );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await client.executeReview(testRequest);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toBe(`${API_URL}/api/v1/review`);
      const init = call[1] as { method: string; headers: Record<string, string>; body: string };
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
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

    it('リクエストセット内のリトライで同じIdempotency-KeyとX-Request-Idが使われること', async () => {
      const networkError = new TypeError('Network error');
      mockFetch
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'cached-job',
            feature: 'review',
            status: 'success',
            payload: testResult,
          }),
        );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await client.executeReview(testRequest);

      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(3);
      const idemKeys = calls.map(
        (c) => (c[1] as { headers: Record<string, string> }).headers[IDEMPOTENCY_KEY_HEADER],
      );
      expect(idemKeys[0]).toBe(idemKeys[1]);
      expect(idemKeys[1]).toBe(idemKeys[2]);
      const reqIds = calls.map(
        (c) => (c[1] as { headers: Record<string, string> }).headers[REQUEST_ID_HEADER],
      );
      expect(reqIds[0]).toBe(reqIds[1]);
      expect(reqIds[1]).toBe(reqIds[2]);
    });
  });

  describe('fetchリトライ', () => {
    it('ネットワークエラー時にリトライして成功すること', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('ECONNREFUSED')).mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'review',
          status: 'success',
          payload: testResult,
        }),
      );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest);
      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('5xxエラー時にリトライして成功すること', async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(503, 'Service Unavailable'))
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'cached-job',
            feature: 'review',
            status: 'success',
            payload: testResult,
          }),
        );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest);
      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('全リトライ失敗時に ApiServerConnectionError がthrowされること', async () => {
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toBeInstanceOf(
        ApiServerConnectionError,
      );
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it('4xxエラーはリトライせず即throwされること', async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(400, 'Bad Request'));
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toThrow(
        'API request failed with status 400',
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Content-Type 検証', () => {
    it('text/htmlなど非JSONレスポンスでエラーがthrowされること', async () => {
      mockFetch.mockResolvedValueOnce(
        createNonJsonResponse('<html><body>HAProxy stats</body></html>', 200, 'text/html'),
      );
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toThrow(
        /Unexpected response content-type/,
      );
    });
  });

  describe('pending 応答→ポーリング', () => {
    it('pending応答後にポーリングで結果取得できること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'job-123',
            feature: 'review',
            status: 'pending',
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'job-123',
            feature: 'review',
            status: 'success',
            payload: testResult,
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest);
      expect(result).toEqual(testResult);
      // 2回目のfetchがGET /api/v1/jobs/job-123 であること
      const pollCall = mockFetch.mock.calls[1]!;
      expect(pollCall[0]).toContain('/api/v1/jobs/job-123');
      expect((pollCall[1] as { method: string }).method).toBe('GET');
    });

    it('pending → 200/pending → 200/success の流れで結果取得できること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ jobId: 'job-pending', feature: 'review', status: 'pending' }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'job-pending',
            feature: 'review',
            status: 'pending',
            currentStep: 'cloning_repository',
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:00:00Z',
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'job-pending',
            feature: 'review',
            status: 'success',
            payload: testResult,
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );

      const onPoll = vi.fn();
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest, onPoll);
      expect(result).toEqual(testResult);
      // pending応答時にonPollがcurrentStepを受け取っていること
      expect(onPoll).toHaveBeenCalled();
      const stepCall = onPoll.mock.calls.find((c) => c[0].currentStep === 'cloning_repository');
      expect(stepCall).toBeDefined();
    });

    it('ポーリング中にfailed status が返ればエラーがthrowされること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ jobId: 'job-fail', feature: 'review', status: 'pending' }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            jobId: 'job-fail',
            feature: 'review',
            status: 'failed',
            errorMessage: 'AI exploded',
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:01:00Z',
          }),
        );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toThrow('AI exploded');
    });

    it('ポーリングで連続404が続くとApiServerJobNotStartedErrorがthrowされること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ jobId: 'never-started', feature: 'review', status: 'pending' }),
        )
        .mockResolvedValue(createJsonResponse({ error: 'Not found' }, 404));

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toBeInstanceOf(
        ApiServerJobNotStartedError,
      );
    });
  });

  describe('onJobIdReceived コールバック', () => {
    it('CLIが生成したjobIdがonJobIdReceivedに渡されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          jobId: 'cached-job',
          feature: 'review',
          status: 'success',
          payload: testResult,
        }),
      );

      const onJobIdReceived = vi.fn();
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await client.executeReview(testRequest, undefined, onJobIdReceived);

      expect(onJobIdReceived).toHaveBeenCalledTimes(1);
      // UUID v4 形式
      expect(onJobIdReceived.mock.calls[0][0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });
});
