import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createReviewRoute } from '../reviewRoute.js';
import type { ReviewRouteEnv } from '../reviewRoute.js';
import type {
  ReviewHandlerDeps,
  PerRequestServiceFactory,
  MrInfoFetcher,
  ReviewExecutor,
} from '../reviewHandler.js';
import type {
  CloneManagerPort,
  CloneResult,
} from '../../../application/shared/port/clone/index.js';
import type { RateLimiterPort } from '../../../application/shared/port/rateLimiter/index.js';
import type { ReviewExecutionDto } from '../../../application/reviewExecution/index.js';
import { ReviewResult } from '../../../domain/reviewResult/index.js';
import { CheckItem } from '../../../domain/checkItem/index.js';
import { Rating } from '../../../domain/rating/index.js';
import { initializeLogger, resetLogger } from '../../../lib/logger.js';

/**
 * SSEレスポンスをパースしてイベントオブジェクトの配列に変換するヘルパー
 */
function parseSSEEvents(text: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let event: string | undefined;
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice('data:'.length).trim();
      }
    }

    if (data) {
      events.push({ event, data });
    }
  }

  return events;
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
function createTestApp(depsOverrides?: Partial<ReviewHandlerDeps>): Hono<ReviewRouteEnv> {
  const deps: ReviewHandlerDeps = {
    cloneManager: createMockCloneManager(),
    serviceFactory: createMockServiceFactory(),
    rateLimiter: createMockRateLimiter(),
    gitlabApiBaseUrl: 'https://gitlab.example.com/api/v4',
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://ai.example.com',
    defaultAiModelName: 'openai/test-model',
    ...depsOverrides,
  };

  const app = new Hono<ReviewRouteEnv>();

  // reviewHandlerDepsをコンテキストに注入するミドルウェア
  app.use('*', async (c, next) => {
    c.set('reviewHandlerDeps', deps);
    await next();
  });

  // レビューAPIルートをマウント
  const reviewRoute = createReviewRoute();
  app.route('/', reviewRoute);

  return app;
}

/**
 * テスト用の有効なリクエストボディを作成するヘルパー
 */
function createValidRequestBody() {
  return {
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
      expect(body.details).toBeDefined();
    });

    it('projectIdが未指定で400エラーが返ること', async () => {
      const app = createTestApp();
      const validBody = createValidRequestBody();
      const requestBody = {
        gitlabToken: validBody.gitlabToken,
        mrIid: validBody.mrIid,
        checklist: validBody.checklist,
        reviewSettings: validBody.reviewSettings,
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('mrIidが未指定で400エラーが返ること', async () => {
      const app = createTestApp();
      const validBody = createValidRequestBody();
      const requestBody = {
        gitlabToken: validBody.gitlabToken,
        projectId: validBody.projectId,
        checklist: validBody.checklist,
        reviewSettings: validBody.reviewSettings,
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('checklistが空配列で400エラーが返ること', async () => {
      const app = createTestApp();
      const requestBody = { ...createValidRequestBody(), checklist: [] };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('checklistが未指定で400エラーが返ること', async () => {
      const app = createTestApp();
      const validBody = createValidRequestBody();
      const requestBody = {
        gitlabToken: validBody.gitlabToken,
        projectId: validBody.projectId,
        mrIid: validBody.mrIid,
        reviewSettings: validBody.reviewSettings,
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation error');
    });

    it('reviewSettingsがオプションで省略可能なこと', async () => {
      const app = createTestApp();
      const requestBody = {
        gitlabToken: 'test-token',
        projectId: '123',
        mrIid: '45',
        checklist: ['Check item 1'],
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      // バリデーション自体は通過する（SSEストリームが返される）
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });
  });

  describe('POST /review - SSEストリーム', () => {
    it('正常なリクエストでSSEストリームが返されること', async () => {
      const app = createTestApp();
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const text = await res.text();
      const events = parseSSEEvents(text);

      // progressイベントが含まれること
      const progressEvents = events.filter((e) => e.event === 'progress');
      expect(progressEvents.length).toBeGreaterThan(0);

      // startedイベントがあること
      const startedEvent = progressEvents.find((e) => {
        const data = JSON.parse(e.data);
        return data.status === 'started';
      });
      expect(startedEvent).toBeDefined();
    });

    it('正常完了時にresultとdoneイベントが含まれること', async () => {
      const app = createTestApp();
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      // resultイベントがReviewApiResponse形式で含まれること
      const resultEvents = events.filter((e) => e.event === 'result');
      expect(resultEvents.length).toBe(1);
      const resultData = JSON.parse(resultEvents[0].data);
      expect(resultData.results).toHaveLength(1);
      expect(resultData.results[0].checkItemContent).toBe('Check item 1');
      expect(resultData.results[0].ratingLabel).toBe('A');
      expect(resultData.results[0].ratingDefinition).toBe('Good');
      expect(resultData.results[0].comment).toBe('All good');
      expect(resultData.results[0].isError).toBe(false);
      expect(resultData.commitHash).toBe('abc123');
      expect(resultData.commitMessage).toBe('Test commit');

      // doneイベントが含まれること
      const doneEvents = events.filter((e) => e.event === 'done');
      expect(doneEvents.length).toBe(1);
      const doneData = JSON.parse(doneEvents[0].data);
      expect(doneData.status).toBe('completed');
    });

    it('進捗イベントが正しい順序で送信されること', async () => {
      const app = createTestApp();
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const progressStatuses = events
        .filter((e) => e.event === 'progress')
        .map((e) => JSON.parse(e.data).status);

      expect(progressStatuses).toContain('started');
      expect(progressStatuses).toContain('fetching_mr_info');
      expect(progressStatuses).toContain('cloning');
      expect(progressStatuses).toContain('reviewing');
      // コメント投稿はCLI側の責務のためposting_commentイベントは送信されない
      expect(progressStatuses).not.toContain('posting_comment');

      // 順序の確認
      const startedIdx = progressStatuses.indexOf('started');
      const fetchingIdx = progressStatuses.indexOf('fetching_mr_info');
      const cloningIdx = progressStatuses.indexOf('cloning');
      const reviewingIdx = progressStatuses.indexOf('reviewing');

      expect(startedIdx).toBeLessThan(fetchingIdx);
      expect(fetchingIdx).toBeLessThan(cloningIdx);
      expect(cloningIdx).toBeLessThan(reviewingIdx);
    });

    it('CloneManagerでエラー発生時にerrorイベントがストリームに含まれること', async () => {
      const mockCloneManager: CloneManagerPort = {
        clone: vi
          .fn<CloneManagerPort['clone']>()
          .mockRejectedValue(new Error('Clone failed: permission denied')),
      };
      const app = createTestApp({ cloneManager: mockCloneManager });
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(200); // SSEストリームは200で開始される
      const text = await res.text();
      const events = parseSSEEvents(text);

      const errorEvents = events.filter((e) => e.event === 'error');
      expect(errorEvents.length).toBe(1);
      const errorData = JSON.parse(errorEvents[0].data);
      expect(errorData.error).toContain('Clone failed');
    });

    it('ReviewExecutorでエラー発生時にerrorイベントがストリームに含まれること', async () => {
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi
            .fn<ReviewExecutor['execute']>()
            .mockRejectedValue(new Error('Workflow execution failed')),
        },
      });
      const app = createTestApp({ serviceFactory: mockServiceFactory });
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const errorEvents = events.filter((e) => e.event === 'error');
      expect(errorEvents.length).toBe(1);
      const errorData = JSON.parse(errorEvents[0].data);
      expect(errorData.error).toContain('Workflow execution failed');
    });

    it('クリーンアップが常に呼び出されること（正常完了時）', async () => {
      const mockCloneManager = createMockCloneManager();
      const app = createTestApp({ cloneManager: mockCloneManager });
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      await res.text(); // ストリームを消費して完了を待つ
      expect(mockCloneManager.cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('クリーンアップがエラー発生時にも呼び出されること', async () => {
      const mockCloneManager = createMockCloneManager();
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi.fn<ReviewExecutor['execute']>().mockRejectedValue(new Error('Review failed')),
        },
      });
      const app = createTestApp({
        cloneManager: mockCloneManager,
        serviceFactory: mockServiceFactory,
      });
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      await res.text();
      expect(mockCloneManager.cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('reviewSettings未指定時にデフォルト値が適用されること', async () => {
      const app = createTestApp();
      const requestBody = {
        gitlabToken: 'test-token',
        projectId: '123',
        mrIid: '45',
        checklist: ['Check item 1'],
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      // エラーなく完了すればデフォルト値が正常に適用されたことを意味する
      const doneEvents = events.filter((e) => e.event === 'done');
      expect(doneEvents.length).toBe(1);
    });

    it('MR情報取得失敗時にerrorイベントがストリームに含まれること', async () => {
      const mockServiceFactory = createMockServiceFactory({
        mrInfoFetcher: {
          fetchBranchInfo: vi
            .fn<MrInfoFetcher['fetchBranchInfo']>()
            .mockRejectedValue(new Error('GitLab API error: 404 Not Found')),
        },
      });
      const app = createTestApp({ serviceFactory: mockServiceFactory });
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const errorEvents = events.filter((e) => e.event === 'error');
      expect(errorEvents.length).toBe(1);
      const errorData = JSON.parse(errorEvents[0].data);
      expect(errorData.error).toContain('GitLab API error');
    });

    it('全結果がエラーの場合でもレビュー結果がReviewApiResponse形式で返ること', async () => {
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue({
            results: [ReviewResult.error(new CheckItem('Check item 1'), 'AI error occurred')],
            commitHash: 'abc123',
            commitMessage: 'Test commit',
          }),
        },
      });
      const app = createTestApp({ serviceFactory: mockServiceFactory });
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      // resultイベントにエラー結果がReviewApiResponse形式で含まれること
      const resultEvents = events.filter((e) => e.event === 'result');
      expect(resultEvents.length).toBe(1);
      const resultData = JSON.parse(resultEvents[0].data);
      expect(resultData.results).toHaveLength(1);
      expect(resultData.results[0].isError).toBe(true);
      expect(resultData.results[0].errorMessage).toBe('AI error occurred');
      expect(resultData.results[0].checkItemContent).toBe('Check item 1');
      expect(resultData.commitHash).toBe('abc123');
      expect(resultData.commitMessage).toBe('Test commit');
    });
  });

  describe('POST /review - resultイベントのReviewApiResponse形式', () => {
    it('resultイベントが品質ゲート情報を含まず、レビュー結果のみ返すこと', async () => {
      const mockServiceFactory = createMockServiceFactory({
        reviewExecutor: {
          execute: vi.fn<ReviewExecutor['execute']>().mockResolvedValue({
            results: [
              ReviewResult.success(
                new CheckItem('Check item 1'),
                new Rating('C', 'Bad'),
                'Issues found',
              ),
            ],
            commitHash: 'abc123',
            commitMessage: 'Test commit',
          }),
        },
      });
      const app = createTestApp({ serviceFactory: mockServiceFactory });
      const requestBody = {
        ...createValidRequestBody(),
        reviewSettings: {
          ratings: [
            { label: 'A', definition: 'Good' },
            { label: 'C', definition: 'Bad' },
          ],
          qualityGate: {
            failureCriteria: [{ ratingLabel: 'C', threshold: 1 }],
          },
        },
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      const resultEvents = events.filter((e) => e.event === 'result');
      expect(resultEvents.length).toBe(1);
      const resultData = JSON.parse(resultEvents[0].data);
      // ReviewApiResponse形式で返ること（品質ゲート情報は含まない）
      expect(resultData.results).toHaveLength(1);
      expect(resultData.results[0].checkItemContent).toBe('Check item 1');
      expect(resultData.results[0].ratingLabel).toBe('C');
      expect(resultData.results[0].ratingDefinition).toBe('Bad');
      expect(resultData.results[0].comment).toBe('Issues found');
      expect(resultData.results[0].isError).toBe(false);
      expect(resultData.commitHash).toBe('abc123');
      expect(resultData.commitMessage).toBe('Test commit');
      // 品質ゲート関連のフィールドは含まれないこと
      expect(resultData.qualityGatePassed).toBeUndefined();
      expect(resultData.qualityGateViolations).toBeUndefined();
    });
  });
});
