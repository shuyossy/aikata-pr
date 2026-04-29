import { Hono } from 'hono';
import { authorizeJobResultAccess, toJobResultResponseBody } from './jobResultHandler.js';
import type { JobResultHandlerDeps } from './jobResultHandler.js';
import type {
  JwtAuthEnv,
  GitLabIdTokenPayload,
} from '../../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../requestIdMiddleware.js';
import { getLogger, runWithLogContext } from '../../../../lib/logger.js';

/**
 * JobResultルートが要求するHonoコンテキスト型
 */
export type JobResultRouteEnv = JwtAuthEnv &
  RequestIdEnv & {
    Variables: {
      jobResultHandlerDeps: JobResultHandlerDeps;
    };
  };

/**
 * GET /jobs/:jobId エンドポイントを提供するルートを作成する
 *
 * SSE接続断時のフォールバック用。クライアントは同一jobIdで結果を再取得できる。
 *
 * 認可方針:
 * - JWT認証有効モード: jwtPayload.user_login と保存userIdの一致を確認
 * - JWT認証無効モード（開発時のみ）: クエリパラメータ ?userId=xxx と保存userIdの一致を確認
 */
export function createJobResultRoute(): Hono<JobResultRouteEnv> {
  const route = new Hono<JobResultRouteEnv>();

  route.get('/jobs/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    const queryUserId = c.req.query('userId') ?? null;
    const jwtPayload = c.get('jwtPayload') as GitLabIdTokenPayload | undefined;
    const jwtUserLogin = jwtPayload?.user_login ?? null;
    const requestId = c.get('requestId');
    const deps = c.get('jobResultHandlerDeps');

    const bindings: Record<string, unknown> = { requestId, jobId };
    if (jwtUserLogin) bindings['userId'] = jwtUserLogin;
    else if (queryUserId) bindings['userId'] = queryUserId;

    return runWithLogContext(bindings, async () => {
      const logger = getLogger();
      let record;
      try {
        record = await deps.jobResultStore.load(jobId);
      } catch (err) {
        logger.error({ err }, 'Failed to load job result record');
        return c.json({ error: 'Internal server error' }, 500);
      }

      if (!record) {
        logger.info('Job result not found');
        return c.json({ error: 'Job not found' }, 404);
      }

      const outcome = authorizeJobResultAccess({
        record,
        jwtUserLogin,
        queryUserId,
      });
      if (outcome.kind === 'deny') {
        logger.warn(
          { reason: outcome.reason, recordUserId: record.userId },
          'Job result access denied',
        );
        return c.json({ error: 'Forbidden' }, 403);
      }

      logger.info({ status: record.status, feature: record.feature }, 'Job result returned');
      return c.json(toJobResultResponseBody(record), 200);
    });
  });

  return route;
}
