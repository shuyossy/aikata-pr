import * as fs from 'node:fs';
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type {
  PipelineAnalysisAgentRequestContext,
  ReportFinalizationJudgeRequestContext,
  ReportRewriteAgentRequestContext,
} from '../../requestContext.js';
import {
  buildReportFinalizationJudgeUserPrompt,
  reportFinalizationJudgementSchema,
} from '../../agents/reportFinalizationJudgeAgent.js';
import { buildReportRewriteUserPrompt } from '../../agents/reportRewriteAgent.js';
import { deriveStageOrder } from '../../agents/pipelineAnalysisAgent.js';
import { buildGenerateOptions, sanitizeForLog } from '../../../shared/requestContext.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../../lib/rateLimitRetry.js';
import { getLogger } from '../../../../lib/logger.js';

export type ReportFinalizationJudgement = z.infer<typeof reportFinalizationJudgementSchema>;

/**
 * reportFinalizationStep の設定
 *
 * ループ制御は workflow 側（dountil）が担うため、本ステップは
 * 「レポートを読み → judge agent で判定 → 必要に応じて rewrite agent で書き換え → 結果を返す」の責務を持つ。
 */
export interface ReportFinalizationStepConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  judgeAgent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rewriteAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  rateLimitRetryConfig: RateLimitRetryConfig;
}

/**
 * reportFinalizationStep の結果
 */
export interface ReportFinalizationStepResult {
  /** 判定/書き換え後のレポート本文 */
  reportContent: string;
  /** レポートが完成しているか（hasMissingJobs=false かつ finalization 完了/不要） */
  isComplete: boolean;
  /** 対象ジョブがレポートに欠落しているか */
  hasMissingJobs: boolean;
  /** hasMissingJobs=true のとき、次回 analysis 呼び出しに渡すフィードバックプロンプト */
  feedbackPrompt: string | null;
  /** rewrite agent によるレポート書き換えが実行されたか */
  finalizationApplied: boolean;
  /** 最後の judge 結果（失敗時の診断に使える） */
  lastJudgement: ReportFinalizationJudgement | null;
}

/**
 * ジョブ欠落時に pipelineAnalysisAgent に渡す再実行フィードバックを組み立てる
 * missingJobReasons のみをフィードバックとして返す（finalizationActions は rewrite agent 側で処理する）
 */
export function buildMissingJobsFeedbackPrompt(judgement: ReportFinalizationJudgement): string {
  const parts: string[] = [];

  parts.push('## Completeness Review Feedback');
  parts.push('');
  parts.push(
    'The QA judge has reviewed the current report file and found missing jobs. You MUST add every missing job listed below before ending your turn.',
  );
  parts.push('');

  parts.push('### Missing Jobs');
  parts.push('');
  for (const reason of judgement.missingJobReasons) {
    parts.push(`- ${reason}`);
  }
  parts.push('');

  parts.push(
    'After fixing these issues, run get-report one more time to confirm every target job has a block and the report is fully complete. Do NOT remove content that is already correct.',
  );

  return parts.join('\n');
}

/**
 * レポート現物＋判定フィードバックを結合した再実行プロンプトを構築する
 *
 * Agent が get-report ツールを呼ばなくてもレポートの現状を即座に把握できるよう、
 * レポート全文をプロンプト先頭に埋め込む。
 */
export function buildFeedbackWithReportPrompt(
  currentReportContent: string,
  feedbackPrompt: string,
): string {
  return `## Current Report Progress
Below is the current state of the report file. Use this as reference to understand what has been completed and what still needs work.

\`\`\`markdown
${currentReportContent}
\`\`\`

---

${feedbackPrompt}`;
}

/**
 * judge agent を呼び出して判定結果を取得する
 */
async function callJudgeAgent(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  judgeAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  currentReportContent: string;
  rateLimitRetryConfig: RateLimitRetryConfig;
}): Promise<ReportFinalizationJudgement> {
  const { judgeAgent, requestContext, currentReportContent, rateLimitRetryConfig } = params;
  const ctx = requestContext.all;

  const userMessages = buildReportFinalizationJudgeUserPrompt({
    currentReportContent,
    targetJobs: ctx.targetJobs,
    jobReportFormat: ctx.jobReportFormat,
    overallTemplate: ctx.overallTemplate,
    stageOrder: deriveStageOrder(ctx.targetJobs),
    reportRefinementInstructions: ctx.reportRefinementInstructions,
  });

  const judgeContext = new RequestContext<ReportFinalizationJudgeRequestContext>([
    ['userId', ctx.userId],
    ['projectId', ctx.projectId],
    ['aiApiKey', ctx.aiApiKey],
    ['aiApiEndpointUrl', ctx.aiApiEndpointUrl],
    ['aiModelName', ctx.aiModelName],
    ['projectDir', ctx.projectDir],
    ['openaiReasoningEffort', ctx.openaiReasoningEffort],
  ]);

  const generateOptions: Record<string, unknown> = {
    requestContext: judgeContext,
    structuredOutput: {
      schema: reportFinalizationJudgementSchema,
      errorStrategy: 'strict',
    },
    ...buildGenerateOptions(ctx),
  };

  const logger = getLogger();
  logger.debug(
    { requestContext: sanitizeForLog(judgeContext.all) },
    'Calling reportFinalizationJudgeAgent.generate',
  );

  const result = await withRateLimitRetry(
    () => judgeAgent.generate(userMessages, generateOptions),
    rateLimitRetryConfig,
    { projectId: ctx.projectId },
  );

  // Mastra の structuredOutput は result.object に乗る
  const obj = (result as { object?: ReportFinalizationJudgement }).object;
  if (obj) {
    return obj;
  }

  // フォールバック: text プロパティを JSON パース
  const text =
    typeof (result as { text?: string }).text === 'string' ? (result as { text: string }).text : '';
  return reportFinalizationJudgementSchema.parse(JSON.parse(text));
}

/**
 * rewrite agent を呼び出してレポートを書き換える
 */
async function callRewriteAgent(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rewriteAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  currentReportContent: string;
  judgement: ReportFinalizationJudgement;
  rateLimitRetryConfig: RateLimitRetryConfig;
}): Promise<string> {
  const { rewriteAgent, requestContext, currentReportContent, judgement, rateLimitRetryConfig } =
    params;
  const ctx = requestContext.all;

  const userPrompt = buildReportRewriteUserPrompt({
    currentReportContent,
    finalizationActions: judgement.finalizationActions,
    reportRefinementInstructions: ctx.reportRefinementInstructions,
    commentLanguage: ctx.commentLanguage,
  });

  const rewriteContext = new RequestContext<ReportRewriteAgentRequestContext>([
    ['userId', ctx.userId],
    ['projectId', ctx.projectId],
    ['aiApiKey', ctx.aiApiKey],
    ['aiApiEndpointUrl', ctx.aiApiEndpointUrl],
    ['aiModelName', ctx.aiModelName],
    ['projectDir', ctx.projectDir],
    ['openaiReasoningEffort', ctx.openaiReasoningEffort],
  ]);

  const generateOptions: Record<string, unknown> = {
    requestContext: rewriteContext,
    ...buildGenerateOptions(ctx),
  };

  const logger = getLogger();
  logger.debug(
    { finalizationActions: judgement.finalizationActions.length },
    'Calling reportRewriteAgent.generate',
  );

  const result = await withRateLimitRetry(
    () => rewriteAgent.generate([{ role: 'user' as const, content: userPrompt }], generateOptions),
    rateLimitRetryConfig,
    { projectId: ctx.projectId },
  );

  const rewrittenReport =
    typeof (result as { text?: string }).text === 'string' ? (result as { text: string }).text : '';

  return rewrittenReport;
}

/**
 * レポートの最終仕上げステップ
 *
 * 処理フロー:
 * 1. resultFilePath を読む
 * 2. judge agent で判定結果を取得
 * 3. hasMissingJobs=true → feedbackPrompt を返す（analysis agent が修正）
 * 4. finalizationNeeded=true かつ hasMissingJobs=false → rewrite agent でレポートを書き換え
 * 5. 両方 false → isComplete=true で返す
 * 6. agent がエラーになった場合は warning ログ + isComplete=false, feedbackPrompt=null を返す
 */
export async function reportFinalizationStep(
  config: ReportFinalizationStepConfig,
): Promise<ReportFinalizationStepResult> {
  const logger = getLogger();
  const { judgeAgent, rewriteAgent, requestContext, rateLimitRetryConfig } = config;

  const resultFilePath = requestContext.get('resultFilePath') as string;

  // 1. 現在のレポートを読む
  const currentReport = await fs.promises.readFile(resultFilePath, 'utf8');

  // 2. judge agent を呼ぶ（パースエラーは warning ログで返却）
  let judgement: ReportFinalizationJudgement;
  try {
    judgement = await callJudgeAgent({
      judgeAgent,
      requestContext,
      currentReportContent: currentReport,
      rateLimitRetryConfig,
    });
  } catch (err) {
    logger.warn(
      { err },
      'Pipeline-report finalization judgement failed to produce structured output; returning current report as-is',
    );
    return {
      reportContent: currentReport,
      isComplete: false,
      hasMissingJobs: false,
      feedbackPrompt: null,
      finalizationApplied: false,
      lastJudgement: null,
    };
  }

  // 3. ジョブ欠落なし かつ 最終化不要 → 完成
  if (!judgement.hasMissingJobs && !judgement.finalizationNeeded) {
    logger.info('Pipeline-report finalization verified: no issues found');
    return {
      reportContent: currentReport,
      isComplete: true,
      hasMissingJobs: false,
      feedbackPrompt: null,
      finalizationApplied: false,
      lastJudgement: judgement,
    };
  }

  // 4. ジョブ欠落あり → フィードバックプロンプトを構築して analysis agent に再実行させる
  if (judgement.hasMissingJobs) {
    logger.info(
      {
        missingJobReasons: judgement.missingJobReasons.length,
        finalizationActions: judgement.finalizationActions.length,
      },
      'Pipeline-report has missing jobs; feedback generated for analysis agent',
    );
    const feedbackPrompt = buildMissingJobsFeedbackPrompt(judgement);
    return {
      reportContent: currentReport,
      isComplete: false,
      hasMissingJobs: true,
      feedbackPrompt,
      finalizationApplied: false,
      lastJudgement: judgement,
    };
  }

  // 5. 最終化のみ必要（ジョブ欠落なし） → rewrite agent でレポートを書き換える
  logger.info(
    { finalizationActions: judgement.finalizationActions.length },
    'Pipeline-report needs finalization; calling rewrite agent',
  );

  try {
    const rewrittenReport = await callRewriteAgent({
      rewriteAgent,
      requestContext,
      currentReportContent: currentReport,
      judgement,
      rateLimitRetryConfig,
    });

    // 書き換え後のレポートをファイルに書き込む
    await fs.promises.writeFile(resultFilePath, rewrittenReport, 'utf8');

    logger.info('Pipeline-report finalization complete: report rewritten');
    return {
      reportContent: rewrittenReport,
      isComplete: true,
      hasMissingJobs: false,
      feedbackPrompt: null,
      finalizationApplied: true,
      lastJudgement: judgement,
    };
  } catch (err) {
    logger.warn({ err }, 'Pipeline-report rewrite agent failed; returning current report as-is');
    return {
      reportContent: currentReport,
      isComplete: false,
      hasMissingJobs: false,
      feedbackPrompt: null,
      finalizationApplied: false,
      lastJudgement: judgement,
    };
  }
}
