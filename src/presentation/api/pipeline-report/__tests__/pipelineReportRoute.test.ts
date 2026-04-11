import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createPipelineReportRoute } from '../pipelineReportRoute.js';
import type { PipelineReportRouteEnv } from '../pipelineReportRoute.js';
import { createRequestIdMiddleware } from '../../shared/requestIdMiddleware.js';
import type {
  PipelineReportHandlerDeps,
  PipelineReportServiceFactory,
  PipelineAnalysisExecutor,
  PipelineMetaFetcher,
} from '../pipelineReportHandler.js';
import type {
  CloneManagerPort,
  CloneResult,
} from '../../../../application/shared/port/clone/index.js';
import type { PipelineAnalysisResult } from '../../../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import type { GitLabIdTokenPayload } from '../../../../infrastructure/adapter/auth/index.js';
import { Pipeline } from '../../../../domain/pipeline-report/pipeline/index.js';
import { Job } from '../../../../domain/pipeline-report/job/index.js';
import { AnalysisReport } from '../../../../domain/pipeline-report/analysisReport/index.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';

/**
 * SSE レスポンスをパースしてイベントオブジェクトの配列に変換するヘルパー
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
 * デフォルトの PipelineAnalysisResult を作成するヘルパー
 */
function createDefaultAnalysisResult(): PipelineAnalysisResult {
  const pipeline = Pipeline.of({
    projectId: 42,
    pipelineId: 2001,
    ref: 'main',
    sha: 'abc123def456',
    status: 'failed',
    webUrl: 'https://gitlab.example.com/project/-/pipelines/2001',
    createdAt: new Date('2026-04-11T09:00:00Z'),
    updatedAt: new Date('2026-04-11T09:15:00Z'),
  });
  const job = Job.of({
    id: 5001,
    name: 'test:unit',
    stage: 'test',
    status: 'failed',
    startedAt: new Date('2026-04-11T09:01:00Z'),
    finishedAt: new Date('2026-04-11T09:05:00Z'),
    duration: 240,
    webUrl: 'https://gitlab.example.com/project/-/jobs/5001',
    failureReason: 'script_failure',
    hasArtifacts: false,
    artifactsSize: 0,
  });
  return {
    report: AnalysisReport.of('# Pipeline Report\n\nall good'),
    targetJobs: [job],
    pipeline,
    completenessVerified: true,
    completenessRetries: 0,
    tokenStats: {
      compressed: false,
      folderTreeStripped: false,
      compressedJobIds: [],
    },
  };
}

/**
 * モック CloneManager
 */
function createMockCloneManager(): CloneManagerPort & {
  clone: ReturnType<typeof vi.fn>;
  cleanupFn: ReturnType<typeof vi.fn>;
} {
  const cleanupFn = vi.fn<CloneResult['cleanup']>().mockResolvedValue(undefined);
  const clone = vi.fn<CloneManagerPort['clone']>().mockResolvedValue({
    projectDir: '/tmp/test-clone',
    sourceBranch: 'main',
    targetBranch: 'main',
    cleanup: cleanupFn,
  });
  return { clone, cleanupFn };
}

/**
 * モック ServiceFactory（metaFetcher + executor）
 */
function createMockServiceFactory(overrides?: {
  analysisResult?: PipelineAnalysisResult;
  metaFetcher?: Partial<PipelineMetaFetcher>;
  executor?: Partial<PipelineAnalysisExecutor>;
}): PipelineReportServiceFactory {
  const analysisResult = overrides?.analysisResult ?? createDefaultAnalysisResult();
  const metaFetcher: PipelineMetaFetcher = {
    getPipeline: vi
      .fn<PipelineMetaFetcher['getPipeline']>()
      .mockResolvedValue(analysisResult.pipeline),
    ...overrides?.metaFetcher,
  };
  const executor: PipelineAnalysisExecutor = {
    analyze: vi.fn<PipelineAnalysisExecutor['analyze']>().mockResolvedValue(analysisResult),
    ...overrides?.executor,
  };
  return {
    create: vi.fn().mockReturnValue({ metaFetcher, executor }),
  };
}

/**
 * テスト用の Hono アプリを作成するヘルパー
 */
function createTestApp(
  depsOverrides?: Partial<PipelineReportHandlerDeps>,
  jwtPayload?: GitLabIdTokenPayload,
): Hono<PipelineReportRouteEnv> {
  const deps: PipelineReportHandlerDeps = {
    cloneManager: createMockCloneManager(),
    serviceFactory: createMockServiceFactory(),
    resultFilePathFactory: () => '/tmp/aikata-pipeline-report-test.md',
    gitlabApiBaseUrl: 'https://gitlab.example.com/api/v4',
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://ai.example.com',
    ...depsOverrides,
  };

  const app = new Hono<PipelineReportRouteEnv>();

  // requestId ミドルウェア（route が c.get('requestId') を参照するため必須）
  app.use('*', createRequestIdMiddleware());

  // 依存注入と JWT payload モックのミドルウェア
  app.use('*', async (c, next) => {
    c.set('pipelineReportHandlerDeps', deps);
    if (jwtPayload) {
      c.set('jwtPayload', jwtPayload);
    }
    await next();
  });

  const route = createPipelineReportRoute();
  app.route('/', route);

  return app;
}

/**
 * テスト用の有効なリクエストボディを作成するヘルパー
 */
function createValidRequestBody(): Record<string, unknown> {
  return {
    userId: 'test-user',
    gitlabToken: 'test-gitlab-token',
    projectId: 42,
    pipelineId: 2001,
    selfJobId: 3001,
    settings: {
      jobReportFormat: '### <jobName>',
      additionalInstructions: 'be strict',
      includeJobPatterns: ['^test:'],
      excludeJobPatterns: [],
    },
    commentLanguage: 'Japanese',
    aiModelName: 'openai/o4-mini',
    maxContextLength: null,
    maxCompletenessRetries: 3,
    skillsRelPaths: [],
  };
}

describe('pipelineReportRoute', () => {
  beforeEach(() => {
    resetLogger();
    initializeLogger({ userId: 'test', level: 'silent', prettyPrint: false });
  });

  afterEach(() => {
    resetLogger();
  });

  describe('POST /pipeline-report — バリデーション', () => {
    it('不正な JSON ボディで 400 エラーが返ること', async () => {
      const app = createTestApp();

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid JSON body');
    });

    it('userId が未指定で 400 エラーが返ること', async () => {
      const app = createTestApp();
      const body = createValidRequestBody();
      delete (body as Record<string, unknown>)['userId'];

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Validation error');
      expect(json.details).toBeDefined();
    });

    it('projectId が文字列で 400 エラーが返ること', async () => {
      const app = createTestApp();
      const body = { ...createValidRequestBody(), projectId: '42' };

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
    });

    it('settings を省略したリクエストがバリデーションを通ること', async () => {
      const app = createTestApp();
      const body = createValidRequestBody();
      delete (body as Record<string, unknown>)['settings'];

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });
  });

  describe('POST /pipeline-report — SSE ストリーム', () => {
    it('正常なリクエストで SSE が返り started/cloning/analyzing/result/done が含まれること', async () => {
      const app = createTestApp();

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const text = await res.text();
      const events = parseSSEEvents(text);

      const progressStatuses = events
        .filter((e) => e.event === 'progress')
        .map((e) => JSON.parse(e.data).status);

      expect(progressStatuses).toContain('started');
      expect(progressStatuses).toContain('fetching_pipeline');
      expect(progressStatuses).toContain('cloning');
      expect(progressStatuses).toContain('analyzing');

      // result イベント
      const resultEvents = events.filter((e) => e.event === 'result');
      expect(resultEvents.length).toBe(1);
      const resultData = JSON.parse(resultEvents[0].data);
      expect(resultData.reportContent).toContain('Pipeline Report');
      expect(resultData.completenessVerified).toBe(true);
      expect(resultData.targetJobIds).toEqual([5001]);
      expect(resultData.pipeline.projectId).toBe(42);
      expect(resultData.pipeline.ref).toBe('main');

      // done イベント
      const doneEvents = events.filter((e) => e.event === 'done');
      expect(doneEvents.length).toBe(1);
    });

    it('CloneManager.clone がパイプラインの ref で source / target を指定されること', async () => {
      const cloneManager = createMockCloneManager();
      const app = createTestApp({ cloneManager });

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });
      // SSE ストリームを最後まで消費しないと handler の処理が完了しないため、明示的に読み切る
      await res.text();

      expect(cloneManager.clone).toHaveBeenCalledTimes(1);
      const cloneArgs = cloneManager.clone.mock.calls[0];
      expect(cloneArgs[0]).toBe('test-gitlab-token'); // gitlabToken
      expect(cloneArgs[1]).toBe('https://gitlab.example.com/api/v4'); // baseUrl
      expect(cloneArgs[2]).toBe('42'); // projectId as string
      expect(cloneArgs[3]).toBe('main'); // sourceBranch = pipeline.ref
      expect(cloneArgs[4]).toBe('main'); // targetBranch = pipeline.ref
    });

    it('PipelineAnalysisExecutor.analyze に正しいコマンドが渡ること', async () => {
      const analysisResult = createDefaultAnalysisResult();
      const analyzeMock = vi
        .fn<PipelineAnalysisExecutor['analyze']>()
        .mockResolvedValue(analysisResult);
      const serviceFactory: PipelineReportServiceFactory = {
        create: vi.fn().mockReturnValue({
          metaFetcher: {
            getPipeline: vi.fn().mockResolvedValue(analysisResult.pipeline),
          },
          executor: { analyze: analyzeMock },
        }),
      };

      const app = createTestApp({ serviceFactory });

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await res.text();

      expect(analyzeMock).toHaveBeenCalledTimes(1);
      const command = analyzeMock.mock.calls[0][0];
      expect(command.userId).toBe('test-user');
      expect(command.projectId).toBe(42);
      expect(command.pipelineId).toBe(2001);
      expect(command.selfJobId).toBe(3001);
      expect(command.commentLanguage).toBe('Japanese');
      expect(command.skillsPaths).toEqual([]);
      expect(command.projectDir).toBe('/tmp/test-clone');
      expect(command.aiConfig.apiKey).toBe('test-api-key');
      expect(command.aiConfig.endpointUrl).toBe('https://ai.example.com');
      expect(command.aiConfig.modelName).toBe('openai/o4-mini');
      expect(command.maxContextLength).toBeNull();
      expect(command.options.maxCompletenessRetries).toBe(3);
      expect(command.settings.includeJobPatterns.length).toBe(1);
      expect(command.settings.includeJobPatterns[0].source).toBe('^test:');
    });

    it('リポジトリクローンが完了後に cleanup が呼ばれること', async () => {
      const cloneManager = createMockCloneManager();
      const app = createTestApp({ cloneManager });

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await res.text();

      expect(cloneManager.cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('analyze が失敗した場合に error SSE イベントが送出され、cleanup は呼ばれること', async () => {
      const analysisResult = createDefaultAnalysisResult();
      const analyzeMock = vi
        .fn<PipelineAnalysisExecutor['analyze']>()
        .mockRejectedValue(new Error('Analysis boom'));
      const serviceFactory: PipelineReportServiceFactory = {
        create: vi.fn().mockReturnValue({
          metaFetcher: {
            getPipeline: vi.fn().mockResolvedValue(analysisResult.pipeline),
          },
          executor: { analyze: analyzeMock },
        }),
      };
      const cloneManager = createMockCloneManager();
      const app = createTestApp({ serviceFactory, cloneManager });

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSSEEvents(text);
      const errorEvents = events.filter((e) => e.event === 'error');
      expect(errorEvents.length).toBe(1);
      const errorData = JSON.parse(errorEvents[0].data);
      expect(errorData.error).toContain('Analysis boom');
      expect(cloneManager.cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('settings.includeJobPatterns に不正 RegExp が含まれる場合に error SSE イベントになること', async () => {
      const app = createTestApp();
      const body = {
        ...createValidRequestBody(),
        settings: {
          includeJobPatterns: ['[unclosed'],
        },
      };

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSSEEvents(text);
      const errorEvents = events.filter((e) => e.event === 'error');
      expect(errorEvents.length).toBe(1);
      expect(JSON.parse(errorEvents[0].data).error).toContain('Invalid RegExp');
    });
  });

  describe('POST /pipeline-report — JWT payload', () => {
    it('JWT 未設定でも正常に処理できること', async () => {
      const app = createTestApp();

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });

      expect(res.status).toBe(200);
    });

    it('JWT の user_login とボディの userId が一致する場合は警告なしで動作すること', async () => {
      const jwtPayload: GitLabIdTokenPayload = {
        user_login: 'test-user',
        user_id: 999,
        user_email: 'test@example.com',
        project_path: 'group/project',
        pipeline_id: 2001,
        job_id: 3001,
      } as GitLabIdTokenPayload;
      const app = createTestApp(undefined, jwtPayload);

      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });

      expect(res.status).toBe(200);
    });
  });
});
