import { createReviewRoute } from './reviewRoute.js';
import type { ReviewRouteEnv } from './reviewRoute.js';
import type { JwtAuthEnv } from '../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../shared/requestIdMiddleware.js';
import type { ApiFeatureModule } from '../shared/featureModule.js';

export { createReviewRoute } from './reviewRoute.js';
export type { ReviewRouteEnv } from './reviewRoute.js';
export {
  createReviewHandler,
  reviewRequestSchema,
  buildReviewSettings,
  DefaultPerRequestServiceFactory,
} from './reviewHandler.js';
export type {
  ReviewRequest,
  ReviewHandlerDeps,
  SSEEvent,
  PerRequestServiceFactory,
  MrInfoFetcher,
  ReviewExecutor,
} from './reviewHandler.js';

/**
 * review機能のAPIモジュール。
 * /api/v1 配下にreviewルートを登録する。
 */
export const reviewApiModule: ApiFeatureModule<JwtAuthEnv & ReviewRouteEnv & RequestIdEnv> = {
  name: 'review',
  register: (app) => {
    const route = createReviewRoute();
    app.route('/api/v1', route);
  },
};
