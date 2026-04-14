import * as fs from 'node:fs';
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type {
  PipelineAnalysisAgentRequestContext,
  ReportCompletenessJudgeRequestContext,
} from '../../requestContext.js';
import {
  buildReportCompletenessJudgeUserPrompt,
  reportCompletenessJudgementSchema,
} from '../../agents/reportCompletenessJudgeAgent.js';
import { deriveStageOrder } from '../../agents/pipelineAnalysisAgent.js';
import { buildGenerateOptions, sanitizeForLog } from '../../../shared/requestContext.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../../lib/rateLimitRetry.js';
import { getLogger } from '../../../../lib/logger.js';

export type ReportCompletenessJudgement = z.infer<typeof reportCompletenessJudgementSchema>;

/**
 * verifyCompletenessStep の設定
 *
 * ループ制御は workflow 側（dountil）が担うため、本ステップは
 * 「レポートを読み → judge agent で判定 → 結果を返す」のみの責務を持つ。
 */
export interface VerifyCompletenessStepConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  judgeAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  rateLimitRetryConfig: RateLimitRetryConfig;
}

/**
 * verifyCompletenessStep の結果
 */
export interface VerifyCompletenessStepResult {
  /** 判定時点のレポート本文 */
  reportContent: string;
  /** 判定が isComplete=true か */
  isComplete: boolean;
  /** isComplete=false のとき、次回 analysis 呼び出しに渡すフィードバックプロンプト */
  feedbackPrompt: string | null;
  /** 最後の judge 結果（失敗時の診断に使える） */
  lastJudgement: ReportCompletenessJudgement | null;
}

/**
 * 判定結果を受けて pipelineAnalysisAgent に渡す再実行フィードバックを組み立てる
 */
export function buildCompletenessFeedbackPrompt(judgement: ReportCompletenessJudgement): string {
  const parts: string[] = [];

  parts.push('## Completeness Review Feedback');
  parts.push('');
  parts.push(
    'The QA judge has reviewed the current report file and found issues. You MUST fix every issue listed below before ending your turn.',
  );
  parts.push('');

  parts.push('### Issues');
  parts.push('');
  for (const reason of judgement.reasons) {
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
}): Promise<ReportCompletenessJudgement> {
  const { judgeAgent, requestContext, currentReportContent, rateLimitRetryConfig } = params;
  const ctx = requestContext.all;

  const userPrompt = buildReportCompletenessJudgeUserPrompt({
    currentReportContent,
    targetJobs: ctx.targetJobs,
    jobReportFormat: ctx.jobReportFormat,
    overallTemplate: ctx.overallTemplate,
    stageOrder: deriveStageOrder(ctx.targetJobs),
  });

  const judgeContext = new RequestContext<ReportCompletenessJudgeRequestContext>([
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
      schema: reportCompletenessJudgementSchema,
      errorStrategy: 'strict',
    },
    ...buildGenerateOptions(ctx),
  };

  const logger = getLogger();
  logger.debug(
    { requestContext: sanitizeForLog(judgeContext.all) },
    'Calling reportCompletenessJudgeAgent.generate',
  );

  const result = await withRateLimitRetry(
    () => judgeAgent.generate(userPrompt, generateOptions),
    rateLimitRetryConfig,
    { projectId: ctx.projectId },
  );

  // Mastra の structuredOutput は result.object に乗る
  const obj = (result as { object?: ReportCompletenessJudgement }).object;
  if (obj) {
    return obj;
  }

  // フォールバック: text プロパティを JSON パース
  const text =
    typeof (result as { text?: string }).text === 'string' ? (result as { text: string }).text : '';
  return reportCompletenessJudgementSchema.parse(JSON.parse(text));
}

/**
 * レポートの完全性を検証するステップ（判定のみ）
 *
 * ループ制御は workflow 側（dountil）が行うため、本関数は1回分の判定のみを実行する。
 *
 * 処理フロー:
 * 1. resultFilePath を読む
 * 2. judge agent に渡して判定結果を取得
 * 3. isComplete / feedbackPrompt を返す
 * 4. judge agent がエラーになった場合は warning ログ + isComplete=false, feedbackPrompt=null を返す
 */
export async function verifyCompletenessStep(
  config: VerifyCompletenessStepConfig,
): Promise<VerifyCompletenessStepResult> {
  const logger = getLogger();
  const { judgeAgent, requestContext, rateLimitRetryConfig } = config;

  const resultFilePath = requestContext.get('resultFilePath') as string;

  // 1. 現在のレポートを読む
  const currentReport = await fs.promises.readFile(resultFilePath, 'utf8');

  // 2. judge agent を呼ぶ（パースエラーは warning ログで返却）
  let judgement: ReportCompletenessJudgement;
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
      'Pipeline-report completeness judgement failed to produce structured output; returning current report as-is',
    );
    return {
      reportContent: currentReport,
      isComplete: false,
      feedbackPrompt: null,
      lastJudgement: null,
    };
  }

  // 3. 完成
  if (judgement.isComplete) {
    logger.info('Pipeline-report completeness verified');
    return {
      reportContent: currentReport,
      isComplete: true,
      feedbackPrompt: null,
      lastJudgement: judgement,
    };
  }

  // 4. 不完全 → フィードバックプロンプトを構築して返す
  logger.info(
    {
      reasons: judgement.reasons.length,
    },
    'Pipeline-report not complete; feedback generated',
  );
  const feedbackPrompt = buildCompletenessFeedbackPrompt(judgement);
  return {
    reportContent: currentReport,
    isComplete: false,
    feedbackPrompt,
    lastJudgement: judgement,
  };
}
