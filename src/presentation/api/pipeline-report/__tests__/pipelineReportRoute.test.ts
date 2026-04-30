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
import type { RateLimiterPort } from '../../../../application/shared/port/rateLimiter/index.js';
import type {
  JobResultStore,
  JobResultRecord,
} from '../../../../application/shared/port/jobResultStore/index.js';
import type { PipelineAnalysisResult } from '../../../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import type { GitLabIdTokenPayload } from '../../../../infrastructure/adapter/auth/index.js';
import { Pipeline } from '../../../../domain/pipeline-report/pipeline/index.js';
import { Job } from '../../../../domain/pipeline-report/job/index.js';
import { AnalysisReport } from '../../../../domain/pipeline-report/analysisReport/index.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';

/**
 * バックグラウンドジョブの完了（success/failedのレコード保存）まで待機するヘルパ
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
    workflowFailed: false,
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
 * モック RateLimiter
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
 * テスト用の Hono アプリを作成するヘルパー
 */
function createTestApp(
  depsOverrides?: Partial<PipelineReportHandlerDeps>,
  jwtPayload?: GitLabIdTokenPayload,
): Hono<PipelineReportRouteEnv> {
  const deps: PipelineReportHandlerDeps = {
    cloneManager: createMockCloneManager(),
    serviceFactory: createMockServiceFactory(),
    rateLimiter: createMockRateLimiter(),
    jobResultStore: createMockJobResultStore(),
    jobResultTtlMs: 86_400_000,
    gitlabApiBaseUrl: 'https://gitlab.example.com/api/v4',
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://ai.example.com',
    defaultAiModelName: 'test-server-model',
    ...depsOverrides,
  };

  const app = new Hono<PipelineReportRouteEnv>();
  app.use('*', createRequestIdMiddleware());
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
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: 'invalid json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid JSON body');
    });

    it('userId が未指定で 400 エラーが返ること', async () => {
      const app = createTestApp();
      const body = createValidRequestBody();
      delete body['userId'];
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    });

    it('projectId が文字列で 400 エラーが返ること', async () => {
      const app = createTestApp();
      const body = { ...createValidRequestBody(), projectId: '42' };
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    });

    it('settings を省略したリクエストがバリデーションを通ること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      const body = createValidRequestBody();
      delete body['settings'];
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      await waitForJobCompletion(store);
    });
  });

  describe('POST /pipeline-report — JSON応答', () => {
    it('正常なリクエストで pending を即時応答し、バックグラウンドで success が保存されること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['feature']).toBe('pipeline-report');
      expect(body['status']).toBe('pending');
      expect(typeof body['jobId']).toBe('string');
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('success');
      if (finalized.status === 'success') {
        const payload = finalized.payload as {
          reportContent: string;
          completenessVerified: boolean;
          targetJobIds: number[];
        };
        expect(payload.reportContent).toContain('Pipeline Report');
        expect(payload.completenessVerified).toBe(true);
        expect(payload.targetJobIds).toEqual([5001]);
      }
    });

    it('CloneManager.clone がパイプラインの ref で source / target を指定されること', async () => {
      const store = createMockJobResultStore();
      const cloneManager = createMockCloneManager();
      const app = createTestApp({ cloneManager, jobResultStore: store });
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      expect(cloneManager.clone).toHaveBeenCalledTimes(1);
      const cloneArgs = cloneManager.clone.mock.calls[0];
      expect(cloneArgs[0]).toBe('test-gitlab-token');
      expect(cloneArgs[1]).toBe('https://gitlab.example.com/api/v4');
      expect(cloneArgs[2]).toBe('42');
      expect(cloneArgs[3]).toBe('main');
      expect(cloneArgs[4]).toBe('main');
      expect(cloneArgs[5]).toBe('abc123def456');
    });

    it('PipelineAnalysisExecutor.analyze に正しいコマンドが渡ること', async () => {
      const store = createMockJobResultStore();
      const analysisResult = createDefaultAnalysisResult();
      const analyzeMock = vi
        .fn<PipelineAnalysisExecutor['analyze']>()
        .mockResolvedValue(analysisResult);
      const serviceFactory: PipelineReportServiceFactory = {
        create: vi.fn().mockReturnValue({
          metaFetcher: { getPipeline: vi.fn().mockResolvedValue(analysisResult.pipeline) },
          executor: { analyze: analyzeMock },
        }),
      };
      const app = createTestApp({ serviceFactory, jobResultStore: store });
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);

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
      expect(command.aiConfig.modelName).toBe('test-server-model');
      expect(command.maxContextLength).toBeNull();
      expect(command.options.maxCompletenessRetries).toBe(3);
      expect(command.options.skipCompletenessCheck).toBe(false);
      expect(command.settings.includeJobPatterns.length).toBe(1);
      expect(command.settings.includeJobPatterns[0].source).toBe('^test:');
    });

    it('deps.maxContextLength がサーバ環境変数由来で analyze コマンドに伝播すること', async () => {
      const store = createMockJobResultStore();
      const analysisResult = createDefaultAnalysisResult();
      const analyzeMock = vi
        .fn<PipelineAnalysisExecutor['analyze']>()
        .mockResolvedValue(analysisResult);
      const serviceFactory: PipelineReportServiceFactory = {
        create: vi.fn().mockReturnValue({
          metaFetcher: { getPipeline: vi.fn().mockResolvedValue(analysisResult.pipeline) },
          executor: { analyze: analyzeMock },
        }),
      };
      const app = createTestApp({ serviceFactory, maxContextLength: 80000, jobResultStore: store });
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      expect(analyzeMock.mock.calls[0][0].maxContextLength).toBe(80000);
    });

    it('rateLimiter に registerProject / unregisterProject が呼ばれること', async () => {
      const store = createMockJobResultStore();
      const rateLimiter = createMockRateLimiter();
      const app = createTestApp({ rateLimiter, jobResultStore: store });
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      expect(rateLimiter.registerProject).toHaveBeenCalledWith('42');
      expect(rateLimiter.unregisterProject).toHaveBeenCalledWith('42');
    });

    it('analyze が失敗しても unregisterProject が呼ばれ、failed レコードが保存されること', async () => {
      const store = createMockJobResultStore();
      const rateLimiter = createMockRateLimiter();
      const analysisResult = createDefaultAnalysisResult();
      const serviceFactory: PipelineReportServiceFactory = {
        create: vi.fn().mockReturnValue({
          metaFetcher: { getPipeline: vi.fn().mockResolvedValue(analysisResult.pipeline) },
          executor: { analyze: vi.fn().mockRejectedValue(new Error('Analysis boom')) },
        }),
      };
      const app = createTestApp({ rateLimiter, serviceFactory, jobResultStore: store });
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('failed');
      if (finalized.status === 'failed') {
        expect(finalized.errorMessage).toContain('Analysis boom');
      }
      expect(rateLimiter.unregisterProject).toHaveBeenCalledWith('42');
    });

    it('リポジトリクローン後に cleanup が呼ばれること', async () => {
      const store = createMockJobResultStore();
      const cloneManager = createMockCloneManager();
      const app = createTestApp({ cloneManager, jobResultStore: store });
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      expect(cloneManager.cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('settings.includeJobPatterns に不正 RegExp が含まれる場合に failed レコードが保存されること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      const body = {
        ...createValidRequestBody(),
        settings: { includeJobPatterns: ['[unclosed'] },
      };
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(body),
      });
      const finalized = await waitForJobCompletion(store);
      expect(finalized.status).toBe('failed');
      if (finalized.status === 'failed') {
        expect(finalized.errorMessage).toContain('Invalid RegExp');
      }
    });
  });

  describe('POST /pipeline-report — JWT payload', () => {
    it('JWT 未設定でも正常に処理できること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      await waitForJobCompletion(store);
    });

    it('JWT の user_login とボディの userId が一致する場合は警告なしで動作すること', async () => {
      const store = createMockJobResultStore();
      const jwtPayload: GitLabIdTokenPayload = {
        user_login: 'test-user',
        user_id: 999,
        user_email: 'test@example.com',
        project_path: 'group/project',
        pipeline_id: 2001,
        job_id: 3001,
      } as GitLabIdTokenPayload;
      const app = createTestApp({ jobResultStore: store }, jwtPayload);
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'test-idem-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      await waitForJobCompletion(store);
    });
  });

  describe('POST /pipeline-report — Idempotency-Key', () => {
    it('X-Idempotency-Keyヘッダ未指定で400エラーが返ること', async () => {
      const app = createTestApp();
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(400);
    });

    it('既存success ジョブを Idempotency-Key 一致で検出し、AI処理を再実行せず結果を返すこと', async () => {
      const store = createMockJobResultStore();
      const cachedPayload = { reportContent: 'cached report', completenessVerified: true };
      await store.save({
        jobId: 'existing-job-id',
        idempotencyKey: 'shared-key',
        feature: 'pipeline-report',
        status: 'success',
        userId: 'test-user',
        payload: cachedPayload,
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        expiresAt: '2026-04-30T00:00:00.000Z',
      });
      const executor: PipelineAnalysisExecutor = {
        analyze: vi
          .fn<PipelineAnalysisExecutor['analyze']>()
          .mockResolvedValue(createDefaultAnalysisResult()),
      };
      const app = createTestApp({
        jobResultStore: store,
        serviceFactory: createMockServiceFactory({ executor }),
      });
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'shared-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('success');
      expect(body['payload']).toEqual(cachedPayload);
      expect(executor.analyze).not.toHaveBeenCalled();
    });

    it('既存pending ジョブを Idempotency-Key 一致で検出し、status=pendingで既存jobIdを返すこと', async () => {
      const store = createMockJobResultStore();
      await store.save({
        jobId: 'pending-job-id',
        idempotencyKey: 'pending-key',
        feature: 'pipeline-report',
        status: 'pending',
        userId: 'test-user',
        currentStep: 'analyzing',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        expiresAt: '2026-04-30T00:00:00.000Z',
      });
      const executor: PipelineAnalysisExecutor = {
        analyze: vi
          .fn<PipelineAnalysisExecutor['analyze']>()
          .mockResolvedValue(createDefaultAnalysisResult()),
      };
      const app = createTestApp({
        jobResultStore: store,
        serviceFactory: createMockServiceFactory({ executor }),
      });
      const res = await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'pending-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('pending');
      expect(body['jobId']).toBe('pending-job-id');
      expect(body['currentStep']).toBe('analyzing');
      expect(executor.analyze).not.toHaveBeenCalled();
    });

    it('正常系: 完了時に pending → success の順で永続化されること', async () => {
      const store = createMockJobResultStore();
      const app = createTestApp({ jobResultStore: store });
      await app.request('/pipeline-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'normal-key' },
        body: JSON.stringify(createValidRequestBody()),
      });
      await waitForJobCompletion(store);
      const pendingSave = store.saveCalls.find((r) => r.status === 'pending');
      const successSave = store.saveCalls.find((r) => r.status === 'success');
      expect(pendingSave).toBeDefined();
      expect(successSave).toBeDefined();
    });
  });
});
