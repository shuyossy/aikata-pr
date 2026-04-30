import { createJobResultRoute } from './jobResultRoute.js';
import type { JobResultRouteEnv } from './jobResultRoute.js';
import type { JwtAuthEnv } from '../../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../requestIdMiddleware.js';
import type { ApiFeatureModule } from '../featureModule.js';

export { createJobResultRoute } from './jobResultRoute.js';
export type { JobResultRouteEnv } from './jobResultRoute.js';
export { authorizeJobResultAccess, toJobResultResponseBody } from './jobResultHandler.js';
export type {
  JobResultHandlerDeps,
  JobResultResponseBody,
  AuthorizationOutcome,
} from './jobResultHandler.js';
export { buildPendingJobRecord, resolveExistingIdempotentJob } from './helpers.js';
export type { ResolveExistingIdempotentJobOutcome } from './helpers.js';

/**
 * jobResult機能のAPIモジュール（feature横断）
 * /api/v1 配下に GET /jobs/:jobId を登録する
 */
export const jobResultApiModule: ApiFeatureModule<JwtAuthEnv & JobResultRouteEnv & RequestIdEnv> = {
  name: 'job-result',
  register: (app) => {
    const route = createJobResultRoute();
    app.route('/api/v1', route);
  },
};
