import { parseCliOptions, buildChecklistParseOptions, type CliOptions } from './lib/cli.js';
import { initializeLogger, getLogger, flushLogger } from './lib/logger.js';
import { ChecklistParser } from './application/shared/parser/index.js';
import { ReviewSettingsParser } from './application/shared/parser/index.js';
import type {
  ReviewWorkflowRunner,
  ReviewWorkflowParams,
  ReviewWorkflowResult,
} from './application/shared/port/workflow/index.js';
import { ReviewExecutionService } from './application/reviewExecution/index.js';
import { CommentPostingService } from './application/commentPosting/index.js';
import { ReviewResult } from './domain/reviewResult/index.js';
import { Rating } from './domain/rating/index.js';
import { GitLabApiClient } from './infrastructure/adapter/httpClient/index.js';
import { GitLabMrGateway, LocalGitDiffMrGateway } from './infrastructure/adapter/gateway/index.js';
import { GitLabMrDiscussionGateway } from './infrastructure/adapter/gateway/index.js';
import { LocalProjectTreeGateway } from './infrastructure/adapter/gateway/index.js';
import { ReviewApiClient } from './infrastructure/adapter/apiClient/index.js';
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
  aiApiKey?: string;
  aiApiEndpointUrl?: string;
  aiModelName?: string;
}

/**
 * 必須パラメータの存在をバリデーションする
 * APIモード時はAI関連パラメータを不要とする
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

  // ローカルモードの場合のみAI関連パラメータを必須とする
  if (!options.aikataApiUrl) {
    if (!options.aiModelName) missing.push('--ai-model-name or AI_MODEL_NAME');
    if (!env['AI_API_KEY']) missing.push('AI_API_KEY');
    if (!env['AI_API_ENDPOINT_URL']) missing.push('AI_API_ENDPOINT_URL');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required parameters: ${missing.join(', ')}`);
  }

  return {
    userId: options.userId!,
    projectId: options.projectId!,
    mrIid: options.mrIid!,
    gitlabToken: options.gitlabToken!,
    checklistPath: options.checklist!,
    aiModelName: options.aiModelName,
    aiApiKey: env['AI_API_KEY'],
    aiApiEndpointUrl: env['AI_API_ENDPOINT_URL'],
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
    const checklistParseOptions = buildChecklistParseOptions(options);
    const checklist = ChecklistParser.parse(checklistCsv, checklistParseOptions);

    const reviewSettings = options.reviewSettings
      ? ReviewSettingsParser.parse(fs.readFileSync(options.reviewSettings, 'utf-8'))
      : ReviewSettings.default();

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

    if (options.aikataApiUrl) {
      // === APIモード ===
      // JWT tokenはAPIモードで必須
      const jwtToken = options.aikataJwt;
      if (!jwtToken) {
        throw new Error(
          'Missing AIKATA_JWT environment variable. Required when AIKATA_API_URL is set.',
        );
      }

      const client = new ReviewApiClient(options.aikataApiUrl, jwtToken);

      const apiResult = await client.executeReview(
        {
          gitlabToken: validated.gitlabToken,
          projectId: validated.projectId,
          mrIid: validated.mrIid,
          checklist: checklist.items.map((i) => i.content),
          reviewSettings: {
            additionalInstructions: reviewSettings.additionalInstructions,
            concurrentReviewCount: reviewSettings.concurrentReviewCount,
            commentFormat: reviewSettings.commentFormat,
            ratings: reviewSettings.ratings.map((r) => ({
              label: r.label,
              definition: r.definition,
            })),
            hiddenRatingLabels: reviewSettings.hiddenRatingLabels,
            qualityGate: {
              failureCriteria: reviewSettings.qualityGate.failureCriteria.map((c) => ({
                ratingLabel: c.ratingLabel,
                threshold: c.threshold,
              })),
            },
          },
          options: {
            commentLanguage: options.commentLanguage,
            skillsPaths: options.skills ? [options.skills] : [],
            treeMaxDepth,
            maxContextLength,
          },
        },
        (event) => {
          logger.info(
            { status: event.status },
            event.message ?? `Review progress: ${event.status}`,
          );
        },
      );

      // APIレスポンスをReviewResult[]に変換
      const results = apiResult.results.map((r) => {
        const checkItem = checklist.items.find((i) => i.content === r.checkItemContent);
        if (!checkItem) {
          throw new Error(`Check item not found in local checklist: ${r.checkItemContent}`);
        }
        if (r.isError) {
          return ReviewResult.error(checkItem, r.errorMessage ?? 'Unknown error');
        }
        return ReviewResult.success(
          checkItem,
          new Rating(r.ratingLabel, r.ratingDefinition),
          r.comment,
        );
      });

      // 全てのレビュー結果がエラーかどうか判定
      const allResultsAreErrors = ReviewResult.allAreErrors(results);

      // 品質ゲート評価
      const qualityGateResult = reviewSettings.qualityGate.evaluate(results);

      // エラーでない場合はコメント投稿
      if (!allResultsAreErrors) {
        const gitlabApiBaseUrl =
          process.env['GITLAB_API_URL'] ??
          process.env['CI_API_V4_URL'] ??
          'https://gitlab.com/api/v4';
        const gitlabClient = new GitLabApiClient(gitlabApiBaseUrl, validated.gitlabToken);
        const mrDiscussionGateway = new GitLabMrDiscussionGateway(gitlabClient);
        const commentService = new CommentPostingService(mrDiscussionGateway);

        await commentService.execute({
          projectId: validated.projectId,
          mrIid: validated.mrIid,
          results,
          ratings: reviewSettings.ratings,
          commitHash: apiResult.commitHash,
          commitMessage: apiResult.commitMessage,
          hiddenRatingLabels: reviewSettings.hiddenRatingLabels,
          qualityGateResult,
        });
      }

      // 終了処理
      logger.info(
        { resultCount: results.length, commentPosted: !allResultsAreErrors },
        'Review completed',
      );

      if (allResultsAreErrors) {
        logger.error('All review results are errors. Exiting with failure.');
        flushLogger();
        process.exit(1);
      }

      if (!qualityGateResult.passed) {
        logger.error('Quality gate failed. Exiting with failure.');
        flushLogger();
        process.exit(1);
      }
    } else {
      // === ローカルモード（既存動作） ===
      // GitLab APIベースURLを環境変数から取得（CI環境では CI_API_V4_URL を使用）
      const gitlabApiBaseUrl =
        process.env['GITLAB_API_URL'] ??
        process.env['CI_API_V4_URL'] ??
        'https://gitlab.com/api/v4';

      // プロジェクトディレクトリ: CI環境ではCI_PROJECT_DIR、ローカルではcwd
      const projectDir = process.env['CI_PROJECT_DIR'] ?? process.cwd();

      // DI組み立て
      const gitlabClient = new GitLabApiClient(gitlabApiBaseUrl, validated.gitlabToken);
      const apiMrGateway = new GitLabMrGateway(gitlabClient);
      const mrGateway = new LocalGitDiffMrGateway(projectDir, apiMrGateway, gitlabClient);
      const mrDiscussionGateway = new GitLabMrDiscussionGateway(gitlabClient);
      const workflowRunner = new MastraReviewWorkflowRunner();
      const treeGateway = new LocalProjectTreeGateway();

      const reviewService = new ReviewExecutionService(
        mrGateway,
        mrDiscussionGateway,
        workflowRunner,
        treeGateway,
      );
      const commentService = new CommentPostingService(mrDiscussionGateway);

      // AIレビュー実行
      const reviewResult = await reviewService.execute({
        userId: validated.userId,
        projectId: validated.projectId,
        mrIid: validated.mrIid,
        checklist,
        reviewSettings,
        skillsPaths: options.skills ? [options.skills] : [],
        projectDir,
        aiApiKey: validated.aiApiKey!,
        aiApiEndpointUrl: validated.aiApiEndpointUrl!,
        aiModelName: validated.aiModelName!,
        gitlabToken: validated.gitlabToken,
        treeMaxDepth,
        commentLanguage: options.commentLanguage,
        openaiReasoningEffort: process.env['OPENAI_REASONING_EFFORT'],
        maxContextLength,
      });

      // 全てのレビュー結果がエラーかどうか判定
      const allResultsAreErrors = ReviewResult.allAreErrors(reviewResult.results);

      // 品質ゲート評価
      const qualityGateResult = reviewSettings.qualityGate.evaluate(reviewResult.results);

      // エラーでない場合はコメント投稿
      if (!allResultsAreErrors) {
        await commentService.execute({
          projectId: validated.projectId,
          mrIid: validated.mrIid,
          results: reviewResult.results,
          ratings: reviewSettings.ratings,
          commitHash: reviewResult.commitHash,
          commitMessage: reviewResult.commitMessage,
          hiddenRatingLabels: reviewSettings.hiddenRatingLabels,
          qualityGateResult,
        });
      }

      logger.info(
        { resultCount: reviewResult.results.length, commentPosted: !allResultsAreErrors },
        'Review completed',
      );

      // 全てのレビュー結果がエラーの場合、ジョブを失敗として終了する
      if (allResultsAreErrors) {
        logger.error('All review results are errors. Exiting with failure.');
        flushLogger();
        process.exit(1);
      }

      // 品質ゲートに抵触した場合、ジョブを失敗として終了する
      if (!qualityGateResult.passed) {
        logger.error('Quality gate failed. Exiting with failure.');
        flushLogger();
        process.exit(1);
      }
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
