import { parseCliOptions, buildChecklistParseOptions } from './lib/cli.js';
import { initializeLogger, getLogger, flushLogger } from './lib/logger.js';
import {
  validateRequiredParams,
  buildApiReviewRequest,
  buildLocalReviewCommand,
} from './lib/commandBuilder.js';
import { ChecklistParser } from './application/shared/parser/index.js';
import { ReviewSettingsParser } from './application/shared/parser/index.js';
import { ReviewExecutionService } from './application/reviewExecution/index.js';
import { CommentPostingService } from './application/commentPosting/index.js';
import { ReviewResult } from './domain/reviewResult/index.js';
import { Rating } from './domain/rating/index.js';
import { GitLabApiClient } from './infrastructure/adapter/httpClient/index.js';
import { GitLabMrGateway, LocalGitDiffMrGateway } from './infrastructure/adapter/gateway/index.js';
import { GitLabMrDiscussionGateway } from './infrastructure/adapter/gateway/index.js';
import { LocalProjectTreeGateway } from './infrastructure/adapter/gateway/index.js';
import { ReviewApiClient } from './infrastructure/adapter/apiClient/index.js';
import { MastraReviewWorkflowRunner } from './infrastructure/adapter/workflow/index.js';
import { GptTokenCounter } from './infrastructure/adapter/tokenCounter/index.js';
import { ReviewSettings } from './domain/reviewSettings/index.js';
import { RateLimiter } from './infrastructure/adapter/rateLimiter/index.js';
import { initializeRateLimiter, resetRateLimiter } from './lib/rateLimiterGlobal.js';
import fs from 'node:fs';

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

      const apiRequest = buildApiReviewRequest(
        validated,
        checklist,
        reviewSettings,
        options,
        treeMaxDepth,
      );

      const apiResult = await client.executeReview(apiRequest, (event) => {
        logger.info({ status: event.status }, event.message ?? `Review progress: ${event.status}`);
      });

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
      // MAX_CONTEXT_LENGTHバリデーション（ローカルモード専用。APIモード時はAPIサーバー側で管理）
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

      // レートリミッターをローカルモード用に初期化
      resetRateLimiter();
      const rateLimiter = new RateLimiter({
        rateLimitPerMin: Number(process.env['AI_API_RATE_LIMIT_PER_MIN'] ?? '60'),
      });
      initializeRateLimiter(rateLimiter);
      rateLimiter.registerProject(validated.projectId);

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
        new GptTokenCounter(),
      );
      const commentService = new CommentPostingService(mrDiscussionGateway);

      // AIレビュー実行
      const reviewCommand = buildLocalReviewCommand(
        validated,
        checklist,
        reviewSettings,
        options,
        projectDir,
        treeMaxDepth,
        maxContextLength,
        process.env['OPENAI_REASONING_EFFORT'],
      );
      const reviewResult = await reviewService.execute(reviewCommand);

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

      // レートリミッタークリーンアップ
      rateLimiter.unregisterProject(validated.projectId);
      rateLimiter.destroy();
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
