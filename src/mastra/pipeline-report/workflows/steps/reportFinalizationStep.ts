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
  /** レポートが完成しているか（finalization 完了/不要） */
  isComplete: boolean;
  /** rewrite agent によるレポート書き換えが実行されたか */
  finalizationApplied: boolean;
  /** 最後の judge 結果（失敗時の診断に使える） */
  lastJudgement: ReportFinalizationJudgement | null;
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
 * 3. finalizationNeeded=false → isComplete=true で返す
 * 4. finalizationNeeded=true → rewrite agent でレポートを書き換え
 * 5. agent がエラーになった場合は warning ログ + isComplete=false を返す
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
      finalizationApplied: false,
      lastJudgement: null,
    };
  }

  // 3. 最終化不要 → 完成
  if (!judgement.finalizationNeeded) {
    logger.info('Pipeline-report finalization verified: no issues found');
    return {
      reportContent: currentReport,
      isComplete: true,
      finalizationApplied: false,
      lastJudgement: judgement,
    };
  }

  // 4. 最終化が必要 → rewrite agent でレポートを書き換える
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
      finalizationApplied: true,
      lastJudgement: judgement,
    };
  } catch (err) {
    logger.warn({ err }, 'Pipeline-report rewrite agent failed; returning current report as-is');
    return {
      reportContent: currentReport,
      isComplete: false,
      finalizationApplied: false,
      lastJudgement: judgement,
    };
  }
}
