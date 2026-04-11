import type { Hono } from 'hono';
import { createReviewRoute } from './reviewRoute.js';
import type { ReviewRouteEnv } from './reviewRoute.js';
import type { JwtAuthEnv } from '../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../shared/requestIdMiddleware.js';
import type { ReviewHandlerDeps } from './reviewHandler.js';

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
 * APIサーバに機能ルートを登録するためのモジュール記述子インターフェース。
 * 各機能はこの形に従うモジュールをexportする。
 */
export interface ApiFeatureModule {
  name: string;
  register: (
    app: Hono<JwtAuthEnv & ReviewRouteEnv & RequestIdEnv>,
    deps: ReviewHandlerDeps,
  ) => void;
}

/**
 * review機能のAPIモジュール。
 * /api/v1 配下にreviewルートを登録する。
 */
export const reviewApiModule: ApiFeatureModule = {
  name: 'review',
  // depsは`createApp`内のミドルウェアでHonoコンテキストに注入されるため、
  // ここでのregister実装はdepsを参照しない（インターフェースでは将来拡張のために残している）
  register: (app) => {
    const route = createReviewRoute();
    app.route('/api/v1', route);
  },
};
