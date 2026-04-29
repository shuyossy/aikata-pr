import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReviewApiClient,
  VERSION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  type ReviewApiRequest,
  type ReviewApiResponse,
  type ReviewProgressEvent,
} from '../ReviewApiClient.js';
import {
  ApiServerConnectionError,
  ApiServerJobNotStartedError,
} from '../../../httpClient/jobResultPolling.js';

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

/**
 * GET /jobs/{id} 用のJSONレスポンスを生成するヘルパー
 */
function createJobResultResponse(status: number, body: Record<string, unknown> | string): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** リトライ・ポーリング待機を最小化したテスト用設定 */
const FAST_RESILIENCE = {
  fetchRetry: { retryCount: 5, baseMs: 1, maxMs: 2 },
  sseIdleTimeoutMs: 100,
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

  describe('正常系: SSEストリーム経由', () => {
    it('SSEレスポンスからレビュー結果を取得できること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { event: 'progress', data: JSON.stringify({ status: 'cloning' }) },
          { event: 'result', data: JSON.stringify(testResult) },
          { event: 'done', data: '{}' },
        ]),
      );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest);

      expect(result).toEqual(testResult);
    });

    it('progressイベントでonProgressコールバックが呼ばれること', async () => {
      const progressEvents: ReviewProgressEvent[] = [
        { status: 'cloning', message: 'Cloning repository...' },
        { status: 'reviewing', message: 'Reviewing code...' },
      ];
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { event: 'progress', data: JSON.stringify(progressEvents[0]) },
          { event: 'progress', data: JSON.stringify(progressEvents[1]) },
          { event: 'result', data: JSON.stringify(testResult) },
        ]),
      );

      const onProgress = vi.fn();
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await client.executeReview(testRequest, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('errorイベントでエラーがスローされること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'error', data: JSON.stringify({ error: 'Review failed' }) }]),
      );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toThrow(
        'Review API error: Review failed',
      );
    });

    it('keepaliveイベントが無視されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([
          { event: 'keepalive', data: '{}' },
          { event: 'result', data: JSON.stringify(testResult) },
        ]),
      );

      const onProgress = vi.fn();
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest, onProgress);

      expect(onProgress).not.toHaveBeenCalled();
      expect(result).toEqual(testResult);
    });

    it('チャンク分割されたSSEストリームを正しくパースできること', async () => {
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

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest);
      expect(result).toEqual(testResult);
    });
  });

  describe('リクエストヘッダ', () => {
    it('正しいURL、ヘッダー、ボディでfetchが呼ばれること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
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
      // X-Idempotency-Key が UUID v4 形式で付与されていること
      expect(init.headers[IDEMPOTENCY_KEY_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(JSON.parse(init.body).userId).toBe('alice');
    });

    it('リクエストセット内のリトライで同じIdempotency-Keyが使われること', async () => {
      // 2回ネットワークエラー → 3回目で成功
      const networkError = new TypeError('Network error');
      mockFetch
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
        );

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await client.executeReview(testRequest);

      // 全3回の呼び出しで同じ Idempotency-Key が使われていること
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

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      const result = await client.executeReview(testRequest);

      expect(result).toEqual(testResult);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('5xxエラー時にリトライして成功すること', async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(503, 'Service Unavailable'))
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
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
      // retryCount=5 なので 6回呼ばれる（初回 + 5リトライ）
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

  describe('SSEフォールバックポーリング', () => {
    it('SSEがresult未受信のまま終了 → GET /jobs/{id} で結果を取得できること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createSSEResponse(
            [
              { event: 'progress', data: JSON.stringify({ status: 'cloning' }) },
              { event: 'done', data: '{}' },
            ],
            200,
            { 'X-Request-Id': 'job-123' },
          ),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
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
      // ポーリング先が existingJobId であること
      expect(mockFetch.mock.calls[1]![0]).toContain('/api/v1/jobs/old-job-456');
    });

    it('ポーリング中にfailed status が返ればエラーがthrowされること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createSSEResponse(
            [
              { event: 'progress', data: JSON.stringify({ status: 'cloning' }) },
              { event: 'done', data: '{}' },
            ],
            200,
            { 'X-Request-Id': 'job-fail' },
          ),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
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
          createSSEResponse([{ event: 'done', data: '{}' }], 200, {
            'X-Request-Id': 'never-started',
          }),
        )
        // 404を繰り返す
        .mockResolvedValue(createJobResultResponse(404, { error: 'Not found' }));

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toBeInstanceOf(
        ApiServerJobNotStartedError,
      );
    });

    it('ポーリング中に200/pendingが続いた後200/successで結果取得できること', async () => {
      mockFetch
        .mockResolvedValueOnce(
          createSSEResponse([{ event: 'done', data: '{}' }], 200, {
            'X-Request-Id': 'job-pending',
          }),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
            jobId: 'job-pending',
            feature: 'review',
            status: 'pending',
            createdAt: '2026-04-29T00:00:00Z',
            updatedAt: '2026-04-29T00:00:00Z',
          }),
        )
        .mockResolvedValueOnce(
          createJobResultResponse(200, {
            jobId: 'job-pending',
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
    });

    it('jobIdが取得できないままSSE終了した場合、エラーがthrowされること', async () => {
      // X-Request-Id ヘッダなしでSSE終了
      mockFetch.mockResolvedValueOnce(createSSEResponse([{ event: 'done', data: '{}' }], 200));

      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await expect(client.executeReview(testRequest)).rejects.toThrow(
        /no jobId is available for polling/,
      );
    });
  });

  describe('レスポンスヘッダ', () => {
    it('レスポンスヘッダのX-Request-IdがonRequestIdコールバックに渡されること', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }], 200, {
          'X-Request-Id': 'server-uuid',
        }),
      );

      const onRequestId = vi.fn();
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await client.executeReview(testRequest, undefined, onRequestId);

      expect(onRequestId).toHaveBeenCalledWith('server-uuid');
    });

    it('X-Request-Idが無いレスポンスではonRequestIdが呼ばれないこと', async () => {
      mockFetch.mockResolvedValueOnce(
        createSSEResponse([{ event: 'result', data: JSON.stringify(testResult) }]),
      );

      const onRequestId = vi.fn();
      const client = new ReviewApiClient(API_URL, JWT_TOKEN, VERSION, FAST_RESILIENCE);
      await client.executeReview(testRequest, undefined, onRequestId);

      expect(onRequestId).not.toHaveBeenCalled();
    });
  });

  describe('SSE idle timeout', () => {
    it('SSEイベントが一定時間来ないとフォールバックポーリングへ移行すること', async () => {
      // SSEレスポンスは届くが、データを送らずstreamを開いたまま
      const stream = new ReadableStream({
        start() {
          // 何もしない（idle）
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
    });
  });
});
