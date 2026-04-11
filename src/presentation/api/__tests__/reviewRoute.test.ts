import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createReviewRoute } from '../reviewRoute.js';
import type { ReviewRouteEnv } from '../reviewRoute.js';
import { createRequestIdMiddleware } from '../requestIdMiddleware.js';
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
import type { GitLabIdTokenPayload } from '../../../infrastructure/adapter/auth/index.js';
import { ReviewResult } from '../../../domain/review/reviewResult/index.js';
import { CheckItem } from '../../../domain/review/checkItem/index.js';
import { Rating } from '../../../domain/review/rating/index.js';
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
 *
 * 必要に応じてJWT payloadをモック注入できる（ログコンテキスト検証用）
 */
function createTestApp(
  depsOverrides?: Partial<ReviewHandlerDeps>,
  jwtPayload?: GitLabIdTokenPayload,
): Hono<ReviewRouteEnv> {
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

  // requestIdミドルウェア（reviewRouteが `c.get('requestId')` を参照するため必須）
  app.use('*', createRequestIdMiddleware());

  // 依存注入とJWT payloadモックのミドルウェア
  app.use('*', async (c, next) => {
    c.set('reviewHandlerDeps', deps);
    if (jwtPayload) {
      c.set('jwtPayload', jwtPayload);
    }
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
        userId: validBody.userId,
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
        userId: validBody.userId,
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

    it('userIdが未指定で400エラーが返ること', async () => {
      const app = createTestApp();
      const validBody = createValidRequestBody();
      const requestBody = {
        gitlabToken: validBody.gitlabToken,
        projectId: validBody.projectId,
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

    it('userIdが空文字で400エラーが返ること', async () => {
      const app = createTestApp();
      const requestBody = { ...createValidRequestBody(), userId: '' };

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
        userId: validBody.userId,
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
        userId: 'test-user',
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
        userId: 'test-user',
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

  describe('POST /review - タイムアウト', () => {
    it('reviewTimeoutMs設定時にタイムアウトするとerrorイベントが返ること', async () => {
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
        reviewTimeoutMs: 50, // 50msで即タイムアウト
      });
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
      expect(errorData.error).toContain('timed out');
    });

    it('reviewTimeoutMs未設定時はタイムアウトしないこと', async () => {
      // reviewTimeoutMs未設定のデフォルト動作
      const app = createTestApp();
      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const text = await res.text();
      const events = parseSSEEvents(text);

      // 正常完了すること
      const doneEvents = events.filter((e) => e.event === 'done');
      expect(doneEvents.length).toBe(1);
    });
  });

  describe('POST /review - ReviewExecutionCommandへのパラメータ伝播', () => {
    /**
     * reviewExecutor.executeに渡されたReviewExecutionCommandをキャプチャするヘルパー
     */
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
          reviewExecutor: {
            execute: executeMock,
          },
        }),
      };

      return { serviceFactory, executeMock };
    }

    it('全リクエストパラメータがReviewExecutionCommandに正しく伝播されること', async () => {
      const { serviceFactory, executeMock } = createCapturingServiceFactory();
      const app = createTestApp({
        serviceFactory,
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
          qualityGate: {
            failureCriteria: [{ ratingLabel: 'C', threshold: 1 }],
          },
        },
        options: {
          commentLanguage: 'English',
          skillsPaths: ['/path/to/skills'],
          treeMaxDepth: 5,
        },
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      await res.text(); // ストリーム消費

      // reviewExecutor.executeが呼ばれたこと
      expect(executeMock).toHaveBeenCalledTimes(1);
      const command = executeMock.mock.calls[0][0];

      // リクエスト由来のフィールド
      expect(command.projectId).toBe('999');
      expect(command.mrIid).toBe('77');
      expect(command.gitlabToken).toBe('my-gitlab-token');
      expect(command.checklist.items.map((i: { content: string }) => i.content)).toEqual([
        '可読性チェック',
        'セキュリティチェック',
      ]);

      // reviewSettings由来
      expect(command.reviewSettings.additionalInstructions).toBe('Be thorough');
      expect(command.reviewSettings.concurrentReviewCount).toBe(3);
      expect(command.reviewSettings.commentFormat).toBe('## Review\n{comment}');
      expect(command.reviewSettings.ratings).toHaveLength(2);
      expect(command.reviewSettings.ratings[0].label).toBe('A');
      expect(command.reviewSettings.ratings[1].label).toBe('C');
      expect(command.reviewSettings.hiddenRatingLabels).toEqual(['A']);
      expect(command.reviewSettings.qualityGate.failureCriteria).toHaveLength(1);
      expect(command.reviewSettings.qualityGate.failureCriteria[0].ratingLabel).toBe('C');

      // options由来
      expect(command.commentLanguage).toBe('English');
      expect(command.skillsPaths).toEqual(['/path/to/skills']);
      expect(command.treeMaxDepth).toBe(5);

      // deps由来（サーバー環境変数）
      expect(command.aiApiKey).toBe('server-api-key');
      expect(command.aiApiEndpointUrl).toBe('https://ai-server.example.com');
      expect(command.aiModelName).toBe('openai/gpt-4o');
      expect(command.openaiReasoningEffort).toBe('medium');
      expect(command.maxContextLength).toBe(80000);

      // userIdはリクエストボディ由来
      expect(command.userId).toBe('charlie');

      // クローン結果由来
      expect(command.projectDir).toBe('/tmp/test-clone');
    });

    it('reviewSettings未指定時にデフォルト値がReviewExecutionCommandに設定されること', async () => {
      const { serviceFactory, executeMock } = createCapturingServiceFactory();
      const app = createTestApp({ serviceFactory });

      const requestBody = {
        userId: 'test-user',
        gitlabToken: 'token',
        projectId: '123',
        mrIid: '45',
        checklist: ['Check item 1'],
        // reviewSettings未指定
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      await res.text();

      const command = executeMock.mock.calls[0][0];

      // デフォルト値が適用されること
      expect(command.reviewSettings.additionalInstructions).toBe('');
      expect(command.reviewSettings.concurrentReviewCount).toBeNull();
      expect(command.reviewSettings.commentFormat).toBe('{comment}');
      expect(command.reviewSettings.ratings.length).toBeGreaterThan(0);
      expect(command.reviewSettings.ratings[0].label).toBe('A');
      expect(command.reviewSettings.hiddenRatingLabels).toEqual([]);
      expect(command.reviewSettings.qualityGate.failureCriteria).toHaveLength(0);
    });

    it('options未指定時にデフォルト値がReviewExecutionCommandに設定されること', async () => {
      const { serviceFactory, executeMock } = createCapturingServiceFactory();
      const app = createTestApp({ serviceFactory });

      const requestBody = {
        userId: 'test-user',
        gitlabToken: 'token',
        projectId: '123',
        mrIid: '45',
        checklist: ['Check item 1'],
        // options未指定
      };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      await res.text();

      const command = executeMock.mock.calls[0][0];

      expect(command.commentLanguage).toBe('Japanese');
      expect(command.skillsPaths).toEqual([]);
      expect(command.treeMaxDepth).toBeUndefined();
      expect(command.maxContextLength).toBeUndefined();
    });

    it('deps由来のパラメータ（AI設定）が正しくCommandに伝播されること', async () => {
      const { serviceFactory, executeMock } = createCapturingServiceFactory();
      const app = createTestApp({
        serviceFactory,
        aiApiKey: 'custom-key',
        aiApiEndpointUrl: 'https://custom-ai.example.com',
        defaultAiModelName: 'openai/custom-model',
        openaiReasoningEffort: 'high',
      });

      const requestBody = createValidRequestBody();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      await res.text();

      const command = executeMock.mock.calls[0][0];

      expect(command.aiApiKey).toBe('custom-key');
      expect(command.aiApiEndpointUrl).toBe('https://custom-ai.example.com');
      expect(command.aiModelName).toBe('openai/custom-model');
      expect(command.openaiReasoningEffort).toBe('high');
    });

    it('userIdがリクエストボディ由来でReviewExecutionCommandに伝播すること', async () => {
      const { serviceFactory, executeMock } = createCapturingServiceFactory();
      const app = createTestApp({ serviceFactory });

      const requestBody = { ...createValidRequestBody(), userId: 'dave' };

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      await res.text();

      const command = executeMock.mock.calls[0][0];
      expect(command.userId).toBe('dave');
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

  describe('POST /review - リクエスト単位のログコンテキスト', () => {
    /**
     * JSONログを捕捉するストリームを返すヘルパー
     *
     * 本describe内では各テストでロガーを再初期化するため、beforeEachで初期化された
     * ロガーをリセットしてから`stream`付きで再生成する。
     */
    function createCapturingApp(
      jwtPayload?: GitLabIdTokenPayload,
      depsOverrides?: Partial<ReviewHandlerDeps>,
    ): {
      app: ReturnType<typeof createTestApp>;
      logs: Array<Record<string, unknown>>;
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
      const app = createTestApp(depsOverrides, jwtPayload);
      return {
        app,
        logs: new Proxy([] as Array<Record<string, unknown>>, {
          get(_target, prop) {
            // 参照時点でのraw→JSONパース結果を都度返す（テスト中にraw.pushされるため）
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
      const { app, logs } = createCapturingApp();

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...createValidRequestBody(), userId: 'alice' }),
      });
      await res.text();

      // 'Review API request received' ログが userId: 'alice' で出力される
      const received = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'Review API request received',
      );
      expect(received).toBeDefined();
      expect(received!['userId']).toBe('alice');
      expect(received!['requestId']).toBeTypeOf('string');
    });

    it('JWT認証有効時にgitlab*補助フィールドがログに追加されること', async () => {
      const { app, logs } = createCapturingApp({
        user_login: 'alice',
        user_id: 42,
        user_email: 'alice@example.com',
        project_path: 'group/project',
        pipeline_id: 111,
        job_id: 222,
      });

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...createValidRequestBody(), userId: 'alice' }),
      });
      await res.text();

      const received = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'Review API request received',
      );
      expect(received).toBeDefined();
      expect(received!['userId']).toBe('alice');
      expect(received!['gitlabUserId']).toBe(42);
      expect(received!['gitlabUserEmail']).toBe('alice@example.com');
      expect(received!['gitlabProjectPath']).toBe('group/project');
      expect(received!['gitlabPipelineId']).toBe(111);
      expect(received!['gitlabJobId']).toBe(222);
      expect(received!['requestId']).toBeTypeOf('string');
    });

    it('JWT user_loginとリクエストボディuserIdが不一致の場合に警告ログが出ること', async () => {
      const { app, logs } = createCapturingApp({
        user_login: 'alice',
        user_id: 42,
      });

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...createValidRequestBody(), userId: 'bob' }),
      });
      await res.text();

      const warning = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'userId in request body does not match JWT user_login claim',
      );
      expect(warning).toBeDefined();
      expect(warning!['bodyUserId']).toBe('bob');
      expect(warning!['jwtUserLogin']).toBe('alice');
      expect(warning!['level']).toBe(40); // pinoのwarn数値
      // 警告ログ自体にもrequestIdとuserId（ボディ由来）が付与されている
      expect(warning!['requestId']).toBeTypeOf('string');
      expect(warning!['userId']).toBe('bob');
    });

    it('X-Request-IdヘッダがレスポンスとログのrequestIdに反映されること', async () => {
      const { app, logs } = createCapturingApp();
      const customId = 'custom-req-id-xyz';

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': customId },
        body: JSON.stringify(createValidRequestBody()),
      });
      await res.text();

      expect(res.headers.get('X-Request-Id')).toBe(customId);

      const received = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'Review API request received',
      );
      expect(received).toBeDefined();
      expect(received!['requestId']).toBe(customId);
    });

    it('JWT user_loginとリクエストボディuserIdが一致する場合は警告ログが出ないこと', async () => {
      const { app, logs } = createCapturingApp({
        user_login: 'alice',
      });

      const res = await app.request('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...createValidRequestBody(), userId: 'alice' }),
      });
      await res.text();

      const warning = (logs as unknown as Array<Record<string, unknown>>).find(
        (l) => l['msg'] === 'userId in request body does not match JWT user_login claim',
      );
      expect(warning).toBeUndefined();
    });
  });
});
