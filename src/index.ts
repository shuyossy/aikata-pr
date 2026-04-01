import { parseCliOptions, type CliOptions } from './lib/cli.js';
import { initializeLogger, getLogger, flushLogger } from './lib/logger.js';
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
import { LocalProjectTreeGateway } from './infrastructure/adapter/gateway/index.js';
import { mastra } from './mastra/index.js';
import { ReviewSettings } from './domain/reviewSettings/index.js';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRequestContext } from './mastra/requestContext.js';
import fs from 'node:fs';

/**
 * Mastra reviewWorkflowをReviewWorkflowRunnerインターフェースにラップする
 */
class MastraReviewWorkflowRunner implements ReviewWorkflowRunner {
  async run(params: ReviewWorkflowParams): Promise<ReviewWorkflowResult> {
    // inputDataからモデル設定・プロジェクト情報を分離
    const {
      userId,
      aiApiKey,
      aiApiEndpointUrl,
      aiModelName,
      projectDir,
      openaiReasoningEffort,
      ...inputData
    } = params;

    // モデル設定・プロジェクト情報をRequestContextに設定
    const requestContext = new RequestContext<WorkflowRequestContext>([
      ['userId', userId],
      ['aiApiKey', aiApiKey],
      ['aiApiEndpointUrl', aiApiEndpointUrl],
      ['aiModelName', aiModelName],
      ['projectDir', projectDir],
      ['openaiReasoningEffort', openaiReasoningEffort],
    ]);

    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    if (result.status === 'failed') {
      throw new Error(`Workflow failed: ${result.error?.message ?? 'Unknown error'}`, {
        cause: result.error,
      });
    }

    if (result.status !== 'success') {
      throw new Error(`Workflow ended with unexpected status: ${result.status}`);
    }

    return result.result as ReviewWorkflowResult;
  }
}

/**
 * バリデーション済みの必須パラメータ
 */
interface ValidatedParams {
  userId: string;
  projectId: string;
  mrIid: string;
  gitlabToken: string;
  checklistPath: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
}

/**
 * 必須パラメータの存在をバリデーションする
 */
function validateRequiredParams(
  options: CliOptions,
  env: Record<string, string | undefined>,
): ValidatedParams {
  const missing: string[] = [];
  if (!options.userId) missing.push('--user-id or USER_ID');
  if (!options.projectId) missing.push('--project-id or GITLAB_PROJECT_ID');
  if (!options.mrIid) missing.push('--mr-iid or GITLAB_MR_IID');
  if (!options.gitlabToken) missing.push('--aikata-pr-gitlab-token or AIKATA_PR_GITLAB_TOKEN');
  if (!options.checklist) missing.push('--checklist or CHECKLIST_PATH');
  if (!options.aiModelName) missing.push('--ai-model-name or AI_MODEL_NAME');
  if (!env['AI_API_KEY']) missing.push('AI_API_KEY');
  if (!env['AI_API_ENDPOINT_URL']) missing.push('AI_API_ENDPOINT_URL');

  if (missing.length > 0) {
    throw new Error(`Missing required parameters: ${missing.join(', ')}`);
  }

  return {
    userId: options.userId!,
    projectId: options.projectId!,
    mrIid: options.mrIid!,
    gitlabToken: options.gitlabToken!,
    checklistPath: options.checklist!,
    aiModelName: options.aiModelName!,
    aiApiKey: env['AI_API_KEY']!,
    aiApiEndpointUrl: env['AI_API_ENDPOINT_URL']!,
  };
}

/**
 * チェックロジックのエントリーポイント
 */
async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2), process.env as Record<string, string>);

  initializeLogger({
    userId: options.userId ?? 'unknown',
    level: options.logLevel,
    prettyPrint: options.prettyPrint,
  });

  const logger = getLogger();
  logger.info('aikata-pr started');

  try {
    // 必須パラメータのバリデーション
    const validated = validateRequiredParams(
      options,
      process.env as Record<string, string | undefined>,
    );

    // 入力ファイル読み込み
    const checklistCsv = fs.readFileSync(validated.checklistPath, 'utf-8');
    const checklist = ChecklistParser.parse(checklistCsv);

    const reviewSettings = options.reviewSettings
      ? ReviewSettingsParser.parse(fs.readFileSync(options.reviewSettings, 'utf-8'))
      : ReviewSettings.default();

    // GitLab APIベースURLを環境変数から取得（CI環境では CI_API_V4_URL を使用）
    const gitlabApiBaseUrl =
      process.env['GITLAB_API_URL'] ?? process.env['CI_API_V4_URL'] ?? 'https://gitlab.com/api/v4';

    // DI組み立て
    const gitlabClient = new GitLabApiClient(gitlabApiBaseUrl, validated.gitlabToken);
    const mrGateway = new GitLabMrGateway(gitlabClient);
    const mrCommentGateway = new GitLabMrCommentGateway(gitlabClient);
    const workflowRunner = new MastraReviewWorkflowRunner();
    const treeGateway = new LocalProjectTreeGateway();

    const service = new ExecuteReviewService(
      mrGateway,
      mrCommentGateway,
      workflowRunner,
      treeGateway,
    );

    // プロジェクトディレクトリ: CI環境ではCI_PROJECT_DIR、ローカルではcwd
    const projectDir = process.env['CI_PROJECT_DIR'] ?? process.cwd();

    // TREE_MAX_DEPTHバリデーション
    const treeMaxDepthEnv = process.env['TREE_MAX_DEPTH'];
    let treeMaxDepth: number | undefined;
    if (treeMaxDepthEnv) {
      treeMaxDepth = Number(treeMaxDepthEnv);
      if (!Number.isInteger(treeMaxDepth) || treeMaxDepth < 1) {
        throw new Error(`Invalid TREE_MAX_DEPTH: ${treeMaxDepthEnv}. Must be a positive integer.`);
      }
    }

    // MAX_CONTEXT_LENGTHバリデーション
    const maxContextLengthEnv = process.env['MAX_CONTEXT_LENGTH'];
    let maxContextLength: number | undefined;
    if (maxContextLengthEnv) {
      maxContextLength = Number(maxContextLengthEnv);
      if (!Number.isInteger(maxContextLength) || maxContextLength < 1) {
        throw new Error(
          `Invalid MAX_CONTEXT_LENGTH: ${maxContextLengthEnv}. Must be a positive integer.`,
        );
      }
    }

    const result = await service.execute({
      userId: validated.userId,
      projectId: validated.projectId,
      mrIid: validated.mrIid,
      checklist,
      reviewSettings,
      skillsPaths: options.skills ? [options.skills] : [],
      projectDir,
      aiApiKey: validated.aiApiKey,
      aiApiEndpointUrl: validated.aiApiEndpointUrl,
      aiModelName: validated.aiModelName,
      gitlabToken: validated.gitlabToken,
      treeMaxDepth,
      commentLanguage: options.commentLanguage,
      openaiReasoningEffort: process.env['OPENAI_REASONING_EFFORT'],
      maxContextLength,
    });

    logger.info(
      { resultCount: result.results.length, commentPosted: result.commentPosted },
      'Review completed',
    );

    // 全てのレビュー結果がエラーの場合、ジョブを失敗として終了する
    if (result.allResultsAreErrors) {
      logger.error('All review results are errors. Exiting with failure.');
      flushLogger();
      process.exit(1);
    }
  } catch (error) {
    const userId = options.userId ?? 'unknown';
    if (error instanceof Error) {
      logger.error({ err: error, userId }, 'Review failed');
    } else {
      logger.error({ userId }, `Review failed: ${String(error)}`);
    }
    flushLogger();
    process.exit(1);
  }
}

main();
