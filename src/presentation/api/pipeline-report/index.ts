import { createPipelineReportRoute } from './pipelineReportRoute.js';
import type { PipelineReportRouteEnv } from './pipelineReportRoute.js';
import type { JwtAuthEnv } from '../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../shared/requestIdMiddleware.js';
import type { ApiFeatureModule } from '../shared/featureModule.js';

export { createPipelineReportRoute } from './pipelineReportRoute.js';
export type { PipelineReportRouteEnv } from './pipelineReportRoute.js';
export {
  createPipelineReportHandler,
  pipelineReportRequestSchema,
  buildPipelineReportSettings,
  DefaultPipelineReportServiceFactory,
} from './pipelineReportHandler.js';
export type {
  PipelineReportRequest,
  PipelineReportHandlerDeps,
  PipelineReportHandlerContext,
  PipelineReportApiResponse,
  PipelineReportServiceFactory,
  PipelineAnalysisExecutor,
  PipelineMetaFetcher,
} from './pipelineReportHandler.js';

/**
 * pipeline-report 機能のAPIモジュール。
 * /api/v1 配下に pipeline-report ルートを登録する。
 */
export const pipelineReportApiModule: ApiFeatureModule<
  JwtAuthEnv & PipelineReportRouteEnv & RequestIdEnv
> = {
  name: 'pipeline-report',
  register: (app) => {
    const route = createPipelineReportRoute();
    app.route('/api/v1', route);
  },
};
