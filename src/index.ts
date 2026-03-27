import { parseCliOptions } from './lib/cli.js';
import { initializeLogger, getLogger } from './lib/logger.js';
import { ChecklistParser } from './application/shared/parser/index.js';
import { ReviewSettingsParser } from './application/shared/parser/index.js';
import type {
  ReviewWorkflowRunner,
  ReviewWorkflowParams,
  ReviewWorkflowResult,
} from './application/executeReview/ExecuteReviewService.js';
import { ExecuteReviewService } from './application/executeReview/ExecuteReviewService.js';
import { GitLabApiClient } from './infrastructure/adapter/httpClient/index.js';
import { GitLabMrGateway } from './infrastructure/adapter/gateway/index.js';
import { GitLabMrCommentGateway } from './infrastructure/adapter/gateway/index.js';
import { reviewWorkflow } from './mastra/workflows/index.js';
import { ReviewSettings } from './domain/reviewSettings/index.js';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRequestContext } from './mastra/requestContext.js';
import fs from 'node:fs';

/**
 * Mastra reviewWorkflowをReviewWorkflowRunnerインターフェースにラップする
 */
class MastraReviewWorkflowRunner implements ReviewWorkflowRunner {
  async run(params: ReviewWorkflowParams): Promise<ReviewWorkflowResult> {
    // inputDataからモデル設定を分離
    const { userId, aiApiKey, aiApiEndpointUrl, aiModelName, ...inputData } = params;

    // モデル設定をRequestContextに設定
    const requestContext = new RequestContext<WorkflowRequestContext>([
      ['userId', userId],
      ['aiApiKey', aiApiKey],
      ['aiApiEndpointUrl', aiApiEndpointUrl],
      ['aiModelName', aiModelName],
    ]);

    const run = await reviewWorkflow.createRun();
    const result = await run.start({ inputData, requestContext });

    if (result.status === 'failed') {
      throw new Error(`Workflow failed: ${result.error?.message ?? 'Unknown error'}`);
    }

    if (result.status !== 'success') {
      throw new Error(`Workflow ended with unexpected status: ${result.status}`);
    }

    return result.result as ReviewWorkflowResult;
  }
}

/**
 * チェックロジックのエントリーポイント
 */
async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2), process.env as Record<string, string>);

  initializeLogger({
    userId: options.userId ?? 'unknown',
    level: options.logLevel,
  });

  const logger = getLogger();
  logger.info('aikata-pr started');

  try {
    // 入力ファイル読み込み
    const checklistCsv = fs.readFileSync(options.checklist!, 'utf-8');
    const checklist = ChecklistParser.parse(checklistCsv);

    const reviewSettings = options.reviewSettings
      ? ReviewSettingsParser.parse(fs.readFileSync(options.reviewSettings, 'utf-8'))
      : ReviewSettings.default();

    // GitLab APIベースURLを環境変数から取得（CI環境では CI_API_V4_URL を使用）
    const gitlabApiBaseUrl =
      process.env['GITLAB_API_URL'] ?? process.env['CI_API_V4_URL'] ?? 'https://gitlab.com/api/v4';

    // DI組み立て
    const gitlabClient = new GitLabApiClient(gitlabApiBaseUrl, options.gitlabToken!);
    const mrGateway = new GitLabMrGateway(gitlabClient);
    const mrCommentGateway = new GitLabMrCommentGateway(gitlabClient);
    const workflowRunner = new MastraReviewWorkflowRunner();

    const service = new ExecuteReviewService(mrGateway, mrCommentGateway, workflowRunner);

    const result = await service.execute({
      userId: options.userId!,
      projectId: options.projectId!,
      mrIid: options.mrIid!,
      checklist,
      reviewSettings,
      skillsPaths: options.skills ? [options.skills] : [],
      aiApiKey: process.env['AI_API_KEY']!,
      aiApiEndpointUrl: process.env['AI_API_ENDPOINT_URL']!,
      aiModelName: options.aiModelName,
      gitlabToken: options.gitlabToken!,
    });

    logger.info(
      { resultCount: result.results.length, commentPosted: result.commentPosted },
      'Review completed',
    );
  } catch (error) {
    const userId = options.userId ?? 'unknown';
    if (options.verboseError && error instanceof Error) {
      logger.error({ err: error, userId }, 'Review failed');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ userId }, `Review failed: ${message}`);
    }
    process.exit(1);
  }
}

main();
