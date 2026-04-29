import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createJobResultRoute } from '../jobResultRoute.js';
import type { JobResultRouteEnv } from '../jobResultRoute.js';
import { createRequestIdMiddleware } from '../../requestIdMiddleware.js';
import type { JobResultStore } from '../../../../../application/shared/port/jobResultStore/index.js';
import type {
  JobResultRecord,
  PendingJobResultRecord,
  SuccessJobResultRecord,
  FailedJobResultRecord,
} from '../../../../../application/shared/port/jobResultStore/index.js';
import type { GitLabIdTokenPayload } from '../../../../../infrastructure/adapter/auth/index.js';
import { initializeLogger, resetLogger } from '../../../../../lib/logger.js';

const NOW_ISO = '2026-04-29T00:00:00.000Z';
const FUTURE_ISO = '2026-04-30T00:00:00.000Z';

function makeSuccess(overrides: Partial<SuccessJobResultRecord> = {}): SuccessJobResultRecord {
  return {
    jobId: overrides.jobId ?? 'job-1',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    feature: overrides.feature ?? 'review',
    status: 'success',
    userId: overrides.userId ?? 'owner-user',
    payload: overrides.payload ?? { results: [] },
    createdAt: overrides.createdAt ?? NOW_ISO,
    updatedAt: overrides.updatedAt ?? NOW_ISO,
    expiresAt: overrides.expiresAt ?? FUTURE_ISO,
  };
}

function makePending(overrides: Partial<PendingJobResultRecord> = {}): PendingJobResultRecord {
  return {
    jobId: overrides.jobId ?? 'job-1',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    feature: overrides.feature ?? 'review',
    status: 'pending',
    userId: overrides.userId ?? 'owner-user',
    createdAt: overrides.createdAt ?? NOW_ISO,
    updatedAt: overrides.updatedAt ?? NOW_ISO,
    expiresAt: overrides.expiresAt ?? FUTURE_ISO,
  };
}

function makeFailed(overrides: Partial<FailedJobResultRecord> = {}): FailedJobResultRecord {
  return {
    jobId: overrides.jobId ?? 'job-1',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    feature: overrides.feature ?? 'review',
    status: 'failed',
    userId: overrides.userId ?? 'owner-user',
    errorMessage: overrides.errorMessage ?? 'something failed',
    createdAt: overrides.createdAt ?? NOW_ISO,
    updatedAt: overrides.updatedAt ?? NOW_ISO,
    expiresAt: overrides.expiresAt ?? FUTURE_ISO,
  };
}

function createMockStore(initialRecord: JobResultRecord | null = null): JobResultStore {
  return {
    save: vi.fn(),
    load: vi.fn(async (jobId: string) => {
      if (initialRecord && initialRecord.jobId === jobId) return initialRecord;
      return null;
    }),
    loadByIdempotencyKey: vi.fn(),
    sweepExpired: vi.fn(async () => 0),
  };
}

function createTestApp(
  store: JobResultStore,
  jwtPayload?: GitLabIdTokenPayload,
): Hono<JobResultRouteEnv> {
  const app = new Hono<JobResultRouteEnv>();
  app.use('*', createRequestIdMiddleware());
  app.use('*', async (c, next) => {
    c.set('jobResultHandlerDeps', { jobResultStore: store });
    if (jwtPayload) {
      c.set('jwtPayload', jwtPayload);
    }
    await next();
  });
  app.route('/', createJobResultRoute());
  return app;
}

describe('jobResultRoute - GET /jobs/:jobId', () => {
  beforeEach(() => {
    resetLogger();
    initializeLogger({ userId: 'test', level: 'silent' });
  });

  afterEach(() => {
    resetLogger();
    vi.restoreAllMocks();
  });

  describe('JWT認証有効モード', () => {
    it('保存されたuserIdとJWT user_loginが一致するsuccessジョブを200で返すこと', async () => {
      const record = makeSuccess({ userId: 'owner-user', payload: { hello: 'world' } });
      const store = createMockStore(record);
      const app = createTestApp(store, { user_login: 'owner-user' });

      const res = await app.request(`/jobs/${record.jobId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['jobId']).toBe(record.jobId);
      expect(body['feature']).toBe('review');
      expect(body['status']).toBe('success');
      expect(body['payload']).toEqual({ hello: 'world' });
    });

    it('pendingジョブをstatus=pendingで返すこと（payload/errorMessageなし）', async () => {
      const record = makePending({ userId: 'owner-user' });
      const store = createMockStore(record);
      const app = createTestApp(store, { user_login: 'owner-user' });

      const res = await app.request(`/jobs/${record.jobId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('pending');
      expect(body['payload']).toBeUndefined();
      expect(body['errorMessage']).toBeUndefined();
    });

    it('failedジョブをstatus=failedとerrorMessage付きで返すこと', async () => {
      const record = makeFailed({ userId: 'owner-user', errorMessage: 'AI failed' });
      const store = createMockStore(record);
      const app = createTestApp(store, { user_login: 'owner-user' });

      const res = await app.request(`/jobs/${record.jobId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('failed');
      expect(body['errorMessage']).toBe('AI failed');
    });

    it('保存userIdとJWT user_loginが不一致の場合は403を返すこと', async () => {
      const record = makeSuccess({ userId: 'owner-user' });
      const store = createMockStore(record);
      const app = createTestApp(store, { user_login: 'different-user' });

      const res = await app.request(`/jobs/${record.jobId}`);
      expect(res.status).toBe(403);
    });

    it('JWT user_loginが未指定の場合は403を返すこと（防御的）', async () => {
      const record = makeSuccess({ userId: 'owner-user' });
      const store = createMockStore(record);
      const app = createTestApp(store, {} as GitLabIdTokenPayload);

      const res = await app.request(`/jobs/${record.jobId}`);
      expect(res.status).toBe(403);
    });

    it('jobIdが存在しない場合は404を返すこと', async () => {
      const store = createMockStore(null);
      const app = createTestApp(store, { user_login: 'owner-user' });

      const res = await app.request('/jobs/nonexistent-id');
      expect(res.status).toBe(404);
    });
  });

  describe('JWT認証無効モード（jwtPayloadなし）', () => {
    it('?userId=xxxが保存userIdと一致する場合は200で結果を返すこと', async () => {
      const record = makeSuccess({ userId: 'cli-user' });
      const store = createMockStore(record);
      const app = createTestApp(store);

      const res = await app.request(`/jobs/${record.jobId}?userId=cli-user`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('success');
    });

    it('?userId=が未指定の場合は403を返すこと', async () => {
      const record = makeSuccess({ userId: 'cli-user' });
      const store = createMockStore(record);
      const app = createTestApp(store);

      const res = await app.request(`/jobs/${record.jobId}`);
      expect(res.status).toBe(403);
    });

    it('?userId=が保存userIdと不一致の場合は403を返すこと', async () => {
      const record = makeSuccess({ userId: 'cli-user' });
      const store = createMockStore(record);
      const app = createTestApp(store);

      const res = await app.request(`/jobs/${record.jobId}?userId=other-user`);
      expect(res.status).toBe(403);
    });

    it('jobIdが存在しない場合（userIdクエリ指定済）でも404を返すこと', async () => {
      const store = createMockStore(null);
      const app = createTestApp(store);

      const res = await app.request('/jobs/nonexistent?userId=cli-user');
      expect(res.status).toBe(404);
    });
  });

  describe('レスポンスヘッダ', () => {
    it('レスポンスにX-Request-Idヘッダが付与されること', async () => {
      const record = makeSuccess({ userId: 'owner-user' });
      const store = createMockStore(record);
      const app = createTestApp(store, { user_login: 'owner-user' });

      const res = await app.request(`/jobs/${record.jobId}`);
      expect(res.headers.get('X-Request-Id')).toBeTruthy();
    });
  });
});
