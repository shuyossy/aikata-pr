import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createReviewRoute } from '../reviewRoute.js';
import type { ReviewRouteEnv } from '../reviewRoute.js';
import { createRequestIdMiddleware } from '../../shared/requestIdMiddleware.js';
import type {
  ReviewHandlerDeps,
  PerRequestServiceFactory,
  MrInfoFetcher,
  ReviewExecutor,
} from '../reviewHandler.js';
import type {
  CloneManagerPort,
  CloneResult,
} from '../../../../application/shared/port/clone/index.js';
import type { RateLimiterPort } from '../../../../application/shared/port/rateLimiter/index.js';
import type {
  JobResultStore,
  JobResultRecord,
} from '../../../../application/shared/port/jobResultStore/index.js';
import type { ReviewExecutionDto } from '../../../../application/review/reviewExecution/index.js';
import type { GitLabIdTokenPayload } from '../../../../infrastructure/adapter/auth/index.js';
import { ReviewResult } from '../../../../domain/review/reviewResult/index.js';
import { CheckItem } from '../../../../domain/review/checkItem/index.js';
import { Rating } from '../../../../domain/review/rating/index.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';

/**
 * バックグラウンドジョブの完了（success/failedのレコード保存）まで待機するヘルパ
 *
 * runBackgroundJob は `void Promise.resolve().then(...)` で起動するため、
 * レスポンス受信後にmicrotaskを進める必要がある。
 * saveCalls にsuccess/failedが現れるまで最大 timeoutMs まで待つ。
 */
async function waitForJobCompletion(
  store: ReturnType<typeof createMockJobResultStore>,
  timeoutMs = 2000,
): Promise<JobResultRecord> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const finalized = store.saveCalls.find((r) => r.status === 'success' || r.status === 'failed');
    if (finalized) return finalized;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Background job did not complete within timeout');
}

/**
 * デフォルトのReviewExecutionDto（正常系）
 */
function createDefaultReviewResult(): ReviewExecutionDto {
  return {
    results: [
      ReviewResult.success(new CheckItem('Check item 1'), new Rating('A', 'Good'), 'All good'),
    ],
    commitHash: 'abc123',
    commitMessage: 'Test commit',
    suggestions: [],
    suggestsToResolve: [],
    baseSha: 'base-sha',
    headSha: 'head-sha',
    startSha: 'start-sha',
  };
}

/**
 * モックCloneManagerを作成するヘルパー
 */
function createMockCloneManager(): CloneManagerPort & {
  clone: ReturnType<typeof vi.fn>;
  cleanupFn: ReturnType<typeof vi.fn>;
} {
  const cleanupFn = vi.fn<CloneResult['cleanup']>().mockResolvedValue(undefined);
  const clone = vi.fn<CloneManagerPort['clone']>().mockResolvedValue({
    projectDir: '/tmp/test-clone',
    sourceBranch: 'feature-branch',
    targetBranch: 'main',
    cleanup: cleanupFn,
  });
  return { clone, cleanupFn };
}

/**
 * モックServiceFactoryを作成するヘルパー
 */
function createMockServiceFactory(overrides?: {
  mrInfoFetcher?: Partial<MrInfoFetcher>;
  reviewExecutor?: Partial<ReviewExecutor>;
}): PerRequestServiceFactory {
  const mrInfoFetcher: MrInfoFetcher = {
    fetchBranchInfo: vi
      .fn<MrInfoFetcher['fetchBranchInfo']>()
      .mockResolvedValue({ source_branch: 'feature-branch', target_branch: 'main' }),
    ...overrides?.mrInfoFetcher,
  };

  const reviewExecutor: ReviewExecutor = {
    execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue(createDefaultReviewResult()),
    ...overrides?.reviewExecutor,
  };

  return {
    create: vi.fn().mockReturnValue({
      mrInfoFetcher,
      reviewExecutor,
    }),
  };
}

/**
 * モックJobResultStoreを作成するヘルパー
 */
function createMockJobResultStore(): JobResultStore & {
  saveCalls: JobResultRecord[];
} {
  const recordsByJobId = new Map<string, JobResultRecord>();
  const recordsByKey = new Map<string, JobResultRecord>();
  const saveCalls: JobResultRecord[] = [];
  return {
    saveCalls,
    save: vi.fn(async (record: JobResultRecord) => {
      saveCalls.push(record);
      recordsByJobId.set(record.jobId, record);
      recordsByKey.set(record.idempotencyKey, record);
    }),
    load: vi.fn(async (jobId: string) => recordsByJobId.get(jobId) ?? null),
    loadByIdempotencyKey: vi.fn(async (key: string) => recordsByKey.get(key) ?? null),
    sweepExpired: vi.fn(async () => 0),
  };
}

/**
 * モックRateLimiterを作成するヘルパー
 */
function createMockRateLimiter(): RateLimiterPort {
  return {
    acquirePermission: vi.fn<RateLimiterPort['acquirePermission']>().mockResolvedValue(undefined),
    reportRateLimit: vi.fn<RateLimiterPort['reportRateLimit']>(),
    reportSuccess: vi.fn<RateLimiterPort['reportSuccess']>(),
    registerProject: vi.fn<RateLimiterPort['registerProject']>(),
    unregisterProject: vi.fn<RateLimiterPort['unregisterProject']>(),
    destroy: vi.fn<RateLimiterPort['destroy']>(),
  };
}

/**
 * テスト用のHonoアプリを作成するヘルパー
 */
function createTestApp(
  depsOverrides?: Partial<ReviewHandlerDeps>,
  jwtPayload?: GitLabIdTokenPayload,
): Hono<ReviewRouteEnv> {
  const deps: ReviewHandlerDeps = {
    cloneManager: createMockCloneManager(),
    serviceFactory: createMockServiceFactory(),
    rateLimiter: createMockRateLimiter(),
    jobResultStore: createMockJobResultStore(),
    jobResultTtlMs: 86_400_000,
    gitlabApiBaseUrl: 'https://gitlab.example.com/api/v4',
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://ai.example.com',
    defaultAiModelName: 'openai/test-model',
    ...depsOverrides,
  };

  const app = new Hono<ReviewRouteEnv>();

  app.use('*', createRequestIdMiddleware());

  app.use('*', async (c, next) => {
    c.set('reviewHandlerDeps', deps);
    if (jwtPayload) {
      c.set('jwtPayload', jwtPayload);
    }
    await next();
  });

  const reviewRoute = createReviewRoute();
  app.route('/', reviewRoute);

  return app;
}

/**
 * テスト用の有効なリクエストボディを作成するヘルパー
 */
function createValidRequestBody() {
  return {
    userId: 'test-user',
    gitlabToken: 'test-gitlab-token',
    projectId: '123',
    mrIid: '45',
    checklist: ['Check item 1'],
    reviewSettings: {
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [
        { label: 'A', definition: 'Good' },
        { label: 'B', definition: 'Needs improvement' },
      ],
      hiddenRatingLabels: [],
      suggestEnabledRatingLabels: [],
    },
  };
}

describe('reviewRoute', () => {
  beforeEach(() => {
    resetLogger();
    initializeLogger({ userId: 'test', level: 'silent' });
  });

  afterEach(() => {
    resetLogger();
  });

  describe('POST /review - バリデーション', () => {
    it('不正なJSONボディで400エラーが返ること', async () => {
      const app = createTestApp();
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: 'invalid json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid JSON body');
    });

    it('gitlabTokenが空で400エラーが返ること', async () => {
      const app = createTestApp();
      const requestBody = { ...createValidRequestBody(), gitlabToken: '' };
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(requestBody),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
      expect(body.details).toBeDefined();
    });

    it.each([
      ['projectId', 'projectId'],
      ['mrIid', 'mrIid'],
      ['userId', 'userId'],
    ])('%sが未指定で400エラーが返ること', async (_label, fieldToOmit) => {
      const app = createTestApp();
      const validBody = createValidRequestBody();
      const requestBody: Record<string, unknown> = { ...validBody };
      delete requestBody[fieldToOmit];
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(requestBody),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('userIdが空文字で400エラーが返ること', async () => {
      const app = createTestApp();
      const requestBody = { ...createValidRequestBody(), userId: '' };
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(requestBody),
      });
      expect(res.status).toBe(400);
    });

    it('checklistが空配列で400エラーが返ること', async () => {
      const app = createTestApp();
      const requestBody = { ...createValidRequestBody(), checklist: [] };
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(requestBody),
      });
      expect(res.status).toBe(400);
    });

    it('reviewSettingsがオプションで省略可能なこと', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      const requestBody = {
        userId: 'test-user',
        gitlabToken: 'test-token',
        projectId: '123',
        mrIid: '45',
        checklist: ['Check item 1'],
      };
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(requestBody),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      await waitForJobCompletion(store);
    });
  });

  describe('POST /review - JSON応答', () => {
    it('正常なリクエストで pending 応答が即時返ること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['feature']).toBe('review');
      expect(body['status']).toBe('pending');
      expect(typeof body['jobId']).toBe('string');
      // バックグラウンド完了まで待ってクリーンアップ
      await waitForJobCompletion(store);
    });

    it('バックグラウンド処理が success レコードを保存すること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'normal-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      const body = (await res.json()) as { jobId: string };
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('success');
      expect(finalized.jobId).toBe(body.jobId);
      if (finalized.status === 'success') {
        const payload = finalized.payload as { results: Array<Record<string, unknown>> };
        expect(payload.results).toHaveLength(1);
        expect(payload.results[0]['checkItemContent']).toBe('Check item 1');
      }
    });

    it('CloneManagerでエラー発生時に failed レコードが保存されること', async () => {
      const store = createMockJobResultStore();
      const mockCloneManager: CloneManagerPort = {
        clone: vi
          .fn<CloneManagerPort['clone']>()
          .mockRejectedValue(new Error('Clone failed: permission denied')),
      };
      const app = createTestApp({ cloneManager: mockCloneManager, jobResultStore: store });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'clone-fail-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('failed');
      if (finalized.status === 'failed') {
        expect(finalized.errorMessage).toContain('Clone failed');
      }
    });

    it('ReviewExecutorでエラー発生時に failed レコードが保存されること', async () => {
      const store = createMockJobResultStore();
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi
            .fn<ReviewExecutor['execute']>()
            .mockRejectedValue(new Error('Workflow execution failed')),
        },
      });
      const app = createTestApp({ serviceFactory: mockServiceFactory, jobResultStore: store });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'wf-fail-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('failed');
      if (finalized.status === 'failed') {
        expect(finalized.errorMessage).toContain('Workflow execution failed');
      }
    });

    it('クリーンアップが常に呼び出されること（正常完了時）', async () => {
      const store = createMockJobResultStore();
      const mockCloneManager = createMockCloneManager();
      const app = createTestApp({ cloneManager: mockCloneManager, jobResultStore: store });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'cleanup-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      expect(mockCloneManager.cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('クリーンアップがエラー発生時にも呼び出されること', async () => {
      const store = createMockJobResultStore();
      const mockCloneManager = createMockCloneManager();
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi.fn<ReviewExecutor['execute']>().mockRejectedValue(new Error('Review failed')),
        },
      });
      const app = createTestApp({
        cloneManager: mockCloneManager,
        serviceFactory: mockServiceFactory,
        jobResultStore: store,
      });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'cleanup-err-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      expect(mockCloneManager.cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('MR情報取得失敗時に failed レコードが保存されること', async () => {
      const store = createMockJobResultStore();
      const mockServiceFactory = createMockServiceFactory({
        mrInfoFetcher: {
          fetchBranchInfo: vi
            .fn<MrInfoFetcher['fetchBranchInfo']>()
            .mockRejectedValue(new Error('GitLab API error: 404 Not Found')),
        },
      });
      const app = createTestApp({ serviceFactory: mockServiceFactory, jobResultStore: store });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'mr-fail-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('failed');
      if (finalized.status === 'failed') {
        expect(finalized.errorMessage).toContain('GitLab API error');
      }
    });

    it('全結果がエラーの場合でも success レコードに ReviewApiResponse が保存されること', async () => {
      const store = createMockJobResultStore();
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue({
            results: [ReviewResult.error(new CheckItem('Check item 1'), 'AI error occurred')],
            commitHash: 'abc123',
            commitMessage: 'Test commit',
            suggestions: [],
            suggestsToResolve: [],
            baseSha: 'base-sha',
            headSha: 'head-sha',
            startSha: 'start-sha',
          }),
        },
      });
      const app = createTestApp({ serviceFactory: mockServiceFactory, jobResultStore: store });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'all-err-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('success');
      if (finalized.status === 'success') {
        const payload = finalized.payload as {
          results: Array<{ isError: boolean; errorMessage?: string; checkItemContent: string }>;
          commitHash: string;
        };
        expect(payload.results[0].isError).toBe(true);
        expect(payload.results[0].errorMessage).toBe('AI error occurred');
        expect(payload.results[0].checkItemContent).toBe('Check item 1');
        expect(payload.commitHash).toBe('abc123');
      }
    });
  });

  describe('POST /review - タイムアウト', () => {
    it('reviewTimeoutMs設定時にタイムアウトすると failed レコードが保存されること', async () => {
      const store = createMockJobResultStore();
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi
            .fn<ReviewExecutor['execute']>()
            .mockImplementation(
              () =>
                new Promise((resolve) =>
                  setTimeout(() => resolve(createDefaultReviewResult()), 5000),
                ),
            ),
        },
      });
      const app = createTestApp({
        serviceFactory: mockServiceFactory,
        reviewTimeoutMs: 50,
        jobResultStore: store,
      });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'timeout-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      const finalized = await waitForJobCompletion(store, 5000);
      expect(finalized.status).toBe('failed');
      if (finalized.status === 'failed') {
        expect(finalized.errorMessage).toContain('timed out');
      }
    });

    it('reviewTimeoutMs未設定時はタイムアウトしないこと', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'no-timeout-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('success');
    });
  });

  describe('POST /review - ReviewExecutionCommandへのパラメータ伝播', () => {
    function createCapturingServiceFactory() {
      const executeMock = vi
        .fn<ReviewExecutor['execute']>()
        .mockResolvedValue(createDefaultReviewResult());
      const serviceFactory: PerRequestServiceFactory = {
        create: vi.fn().mockReturnValue({
          mrInfoFetcher: {
            fetchBranchInfo: vi
              .fn<MrInfoFetcher['fetchBranchInfo']>()
              .mockResolvedValue({ source_branch: 'feature-branch', target_branch: 'main' }),
          },
          reviewExecutor: { execute: executeMock },
        }),
      };
      return { serviceFactory, executeMock };
    }

    it('全リクエストパラメータがReviewExecutionCommandに正しく伝播されること', async () => {
      const store = createMockJobResultStore();
      const { serviceFactory, executeMock } = createCapturingServiceFactory();
      const app = createTestApp({
        serviceFactory,
        jobResultStore: store,
        aiApiKey: 'server-api-key',
        aiApiEndpointUrl: 'https://ai-server.example.com',
        defaultAiModelName: 'openai/gpt-4o',
        openaiReasoningEffort: 'medium',
        maxContextLength: 80000,
      });

      const requestBody = {
        userId: 'charlie',
        gitlabToken: 'my-gitlab-token',
        projectId: '999',
        mrIid: '77',
        checklist: ['可読性チェック', 'セキュリティチェック'],
        reviewSettings: {
          additionalInstructions: 'Be thorough',
          concurrentReviewCount: 3,
          commentFormat: '## Review\n{comment}',
          ratings: [
            { label: 'A', definition: 'Excellent' },
            { label: 'C', definition: 'Poor' },
          ],
          hiddenRatingLabels: ['A'],
          qualityGate: { failureCriteria: [{ ratingLabel: 'C', threshold: 1 }] },
        },
        options: {
          commentLanguage: 'English',
          skillsPaths: ['/path/to/skills'],
          treeMaxDepth: 5,
        },
      };

      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'param-key' },
        body: JSON.stringify(requestBody),
      });
      await waitForJobCompletion(store);

      expect(executeMock).toHaveBeenCalledTimes(1);
      const command = executeMock.mock.calls[0][0];
      expect(command.projectId).toBe('999');
      expect(command.mrIid).toBe('77');
      expect(command.gitlabToken).toBe('my-gitlab-token');
      expect(command.checklist.items.map((i: { content: string }) => i.content)).toEqual([
        '可読性チェック',
        'セキュリティチェック',
      ]);
      expect(command.reviewSettings.additionalInstructions).toBe('Be thorough');
      expect(command.reviewSettings.concurrentReviewCount).toBe(3);
      expect(command.reviewSettings.ratings).toHaveLength(2);
      expect(command.reviewSettings.hiddenRatingLabels).toEqual(['A']);
      expect(command.reviewSettings.qualityGate.failureCriteria).toHaveLength(1);
      expect(command.commentLanguage).toBe('English');
      expect(command.skillsPaths).toEqual(['/path/to/skills']);
      expect(command.treeMaxDepth).toBe(5);
      expect(command.aiApiKey).toBe('server-api-key');
      expect(command.aiApiEndpointUrl).toBe('https://ai-server.example.com');
      expect(command.aiModelName).toBe('openai/gpt-4o');
      expect(command.openaiReasoningEffort).toBe('medium');
      expect(command.maxContextLength).toBe(80000);
      expect(command.userId).toBe('charlie');
      expect(command.projectDir).toBe('/tmp/test-clone');
    });

    it('reviewSettings/options 未指定時にデフォルト値がCommandに設定されること', async () => {
      const store = createMockJobResultStore();
      const { serviceFactory, executeMock } = createCapturingServiceFactory();
      const app = createTestApp({ serviceFactory, jobResultStore: store });
      const requestBody = {
        userId: 'test-user',
        gitlabToken: 'token',
        projectId: '123',
        mrIid: '45',
        checklist: ['Check item 1'],
      };
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'default-key' },
        body: JSON.stringify(requestBody),
      });
      await waitForJobCompletion(store);

      const command = executeMock.mock.calls[0][0];
      expect(command.reviewSettings.additionalInstructions).toBe('');
      expect(command.reviewSettings.concurrentReviewCount).toBeNull();
      expect(command.reviewSettings.ratings.length).toBeGreaterThan(0);
      expect(command.commentLanguage).toBe('Japanese');
      expect(command.skillsPaths).toEqual([]);
      expect(command.treeMaxDepth).toBeUndefined();
    });
  });

  describe('POST /review - リクエスト単位のログコンテキスト', () => {
    function createCapturingApp(
      jwtPayload?: GitLabIdTokenPayload,
      depsOverrides?: Partial<ReviewHandlerDeps>,
    ): {
      app: ReturnType<typeof createTestApp>;
      logs: Array<Record<string, unknown>>;
      store: ReturnType<typeof createMockJobResultStore>;
    } {
      resetLogger();
      const raw: string[] = [];
      initializeLogger({
        userId: 'api-server',
        prettyPrint: false,
        stream: {
          write(chunk: string) {
            raw.push(chunk);
          },
        },
      });
      const store = createMockJobResultStore();
      const app = createTestApp({ ...depsOverrides, jobResultStore: store }, jwtPayload);
      return {
        app,
        store,
        logs: new Proxy([] as Array<Record<string, unknown>>, {
          get(_target, prop) {
            const parsed = raw
              .filter((l) => l.trim().length > 0)
              .map((l) => JSON.parse(l) as Record<string, unknown>);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (parsed as any)[prop];
          },
        }),
      };
    }

    it('リクエストボディのuserIdがログに記録されること（JWT認証無効モード）', async () => {
      const { app, logs, store } = createCapturingApp();
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'log-key1' },
        body: JSON.stringify({ ...createValidRequestBody(), userId: 'alice' }),
      });
      await waitForJobCompletion(store);

      const received = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'Review API request received',
      );
      expect(received).toBeDefined();
      expect(received!['userId']).toBe('alice');
      expect(received!['requestId']).toBeTypeOf('string');
    });

    it('JWT認証有効時にgitlab*補助フィールドがログに追加されること', async () => {
      const { app, logs, store } = createCapturingApp({
        user_login: 'alice',
        user_id: 42,
        user_email: 'alice@example.com',
        project_path: 'group/project',
        pipeline_id: 111,
        job_id: 222,
      });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'log-key2' },
        body: JSON.stringify({ ...createValidRequestBody(), userId: 'alice' }),
      });
      await waitForJobCompletion(store);
      const received = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'Review API request received',
      );
      expect(received).toBeDefined();
      expect(received!['gitlabUserId']).toBe(42);
      expect(received!['gitlabUserEmail']).toBe('alice@example.com');
      expect(received!['gitlabProjectPath']).toBe('group/project');
      expect(received!['gitlabPipelineId']).toBe(111);
      expect(received!['gitlabJobId']).toBe(222);
    });

    it('JWT user_loginとリクエストボディuserIdが不一致の場合に警告ログが出ること', async () => {
      const { app, logs, store } = createCapturingApp({ user_login: 'alice', user_id: 42 });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'log-key3' },
        body: JSON.stringify({ ...createValidRequestBody(), userId: 'bob' }),
      });
      await waitForJobCompletion(store);
      const warning = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'userId in request body does not match JWT user_login claim',
      );
      expect(warning).toBeDefined();
      expect(warning!['bodyUserId']).toBe('bob');
      expect(warning!['jwtUserLogin']).toBe('alice');
      expect(warning!['level']).toBe(40);
    });

    it('X-Request-Idヘッダがレスポンスとログに反映されること', async () => {
      const { app, logs, store } = createCapturingApp();
      const customId = 'custom-req-id-xyz';
      const res = await app.request('/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': customId,
          'X-Idempotency-Key': 'log-key4',
        },
        body: JSON.stringify(createValidRequestBody()),
      });
      const body = (await res.json()) as { jobId: string };
      expect(res.headers.get('X-Request-Id')).toBe(customId);
      // CLI制御のjobIdとしてX-Request-Idが採用される
      expect(body.jobId).toBe(customId);
      await waitForJobCompletion(store);
      const received = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'Review API request received',
      );
      expect(received).toBeDefined();
      expect(received!['requestId']).toBe(customId);
    });
  });

  describe('POST /review - Idempotency-Key', () => {
    it('X-Idempotency-Keyヘッダ未指定で400エラーが返ること', async () => {
      const app = createTestApp();
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['error']).toContain('X-Idempotency-Key');
    });

    it('X-Idempotency-Keyヘッダが空文字で400エラーが返ること', async () => {
      const app = createTestApp();
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': '   ' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(400);
    });

    it('既存success ジョブを Idempotency-Key 一致で検出し、AI処理を再実行せず結果を返すこと', async () => {
      const store = createMockJobResultStore();
      const cachedPayload = { results: [{ checkItemContent: 'cached', ratingLabel: 'A' }] };
      await store.save({
        jobId: 'existing-job-id',
        idempotencyKey: 'shared-key',
        feature: 'review',
        status: 'success',
        userId: 'test-user',
        payload: cachedPayload,
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        expiresAt: '2026-04-30T00:00:00.000Z',
      });
      const reviewExecutor: ReviewExecutor = {
        execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue(createDefaultReviewResult()),
      };
      const app = createTestApp({
        jobResultStore: store,
        serviceFactory: createMockServiceFactory({ reviewExecutor }),
      });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'shared-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('success');
      expect(body['jobId']).toBe('existing-job-id');
      expect(body['payload']).toEqual(cachedPayload);
      expect(reviewExecutor.execute).not.toHaveBeenCalled();
    });

    it('既存failed ジョブを Idempotency-Key 一致で検出し、status=failed応答を返すこと', async () => {
      const store = createMockJobResultStore();
      await store.save({
        jobId: 'failed-job-id',
        idempotencyKey: 'failed-key',
        feature: 'review',
        status: 'failed',
        userId: 'test-user',
        errorMessage: 'previous AI failure',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        expiresAt: '2026-04-30T00:00:00.000Z',
      });
      const reviewExecutor: ReviewExecutor = {
        execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue(createDefaultReviewResult()),
      };
      const app = createTestApp({
        jobResultStore: store,
        serviceFactory: createMockServiceFactory({ reviewExecutor }),
      });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'failed-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('failed');
      expect(body['errorMessage']).toBe('previous AI failure');
      expect(reviewExecutor.execute).not.toHaveBeenCalled();
    });

    it('既存pending ジョブを Idempotency-Key 一致で検出し、status=pendingで既存jobIdを返すこと', async () => {
      const store = createMockJobResultStore();
      await store.save({
        jobId: 'pending-job-id',
        idempotencyKey: 'pending-key',
        feature: 'review',
        status: 'pending',
        userId: 'test-user',
        currentStep: 'reviewing',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        expiresAt: '2026-04-30T00:00:00.000Z',
      });
      const reviewExecutor: ReviewExecutor = {
        execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue(createDefaultReviewResult()),
      };
      const app = createTestApp({
        jobResultStore: store,
        serviceFactory: createMockServiceFactory({ reviewExecutor }),
      });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'pending-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('pending');
      expect(body['jobId']).toBe('pending-job-id');
      expect(body['currentStep']).toBe('reviewing');
      expect(reviewExecutor.execute).not.toHaveBeenCalled();
    });

    it('既存ジョブのuserIdが要求userIdと不一致なら409を返すこと', async () => {
      const store = createMockJobResultStore();
      await store.save({
        jobId: 'other-user-job',
        idempotencyKey: 'collision-key',
        feature: 'review',
        status: 'success',
        userId: 'different-user',
        payload: { secret: 'belongs to someone else' },
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        expiresAt: '2026-04-30T00:00:00.000Z',
      });
      const reviewExecutor: ReviewExecutor = {
        execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue(createDefaultReviewResult()),
      };
      const app = createTestApp({
        jobResultStore: store,
        serviceFactory: createMockServiceFactory({ reviewExecutor }),
      });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'collision-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(409);
      expect(reviewExecutor.execute).not.toHaveBeenCalled();
    });

    it('正常系: 完了時に pending → success の順で永続化されること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'persist-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      const pendingSave = store.saveCalls.find((r) => r.status === 'pending');
      const successSave = store.saveCalls.find((r) => r.status === 'success');
      expect(pendingSave).toBeDefined();
      expect(successSave).toBeDefined();
      expect(successSave!.idempotencyKey).toBe('persist-key');
    });

    it('pending保存に失敗した場合は500応答でAI処理は開始しないこと', async () => {
      const failingStore: JobResultStore = {
        save: vi.fn(async () => {
          throw new Error('disk full');
        }),
        load: vi.fn(async () => null),
        loadByIdempotencyKey: vi.fn(async () => null),
        sweepExpired: vi.fn(async () => 0),
      };
      const reviewExecutor: ReviewExecutor = {
        execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue(createDefaultReviewResult()),
      };
      const app = createTestApp({
        jobResultStore: failingStore,
        serviceFactory: createMockServiceFactory({ reviewExecutor }),
      });
      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'fail-save-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(500);
      // AI処理は呼ばれない
      expect(reviewExecutor.execute).not.toHaveBeenCalled();
    });
  });
});
