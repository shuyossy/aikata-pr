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
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../../lib/rateLimitRetry.js';
import { classifyError } from '../../../../lib/errorClassifier.js';
import { RateLimitExhaustedError } from '../../../../lib/rateLimiterGlobal.js';
import { getLogger } from '../../../../lib/logger.js';
import { recoverFromContextLength } from './contextLengthRecovery.js';

export type ReportCompletenessJudgement = z.infer<typeof reportCompletenessJudgementSchema>;

/**
 * verifyCompletenessStep の設定
 */
export interface VerifyCompletenessStepConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisAgent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  judgeAgent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  /**
   * executeAnalysisStep が使用した最終スレッドID
   * 不足項目再実行時は同じスレッドに継続プロンプトを送る
   */
  threadId: string;
  /** 最大再実行回数（判定上限） */
  maxCompletenessRetries: number;
  /** `pipelineAnalysisAgent.generate()` に渡す追加オプション */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraGenerateOptions?: Record<string, any>;
  rateLimitRetryConfig: RateLimitRetryConfig;
}

/**
 * verifyCompletenessStep の結果
 */
export interface VerifyCompletenessStepResult {
  /** 最終的なレポート本文 */
  reportContent: string;
  /** 判定が isComplete=true で終了したか */
  completenessVerified: boolean;
  /** verify → 再実行 → verify のサイクル実行回数 */
  completenessRetries: number;
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
    'A strict QA judge has reviewed the current report file and found issues. You MUST fix every issue listed below before ending your turn. Use get-report to re-read the current file, then use patch-report for precise edits.',
  );
  parts.push('');

  if (judgement.missingItems.length > 0) {
    parts.push('### Missing Job Blocks / Unresolved Placeholders');
    parts.push('');
    for (const item of judgement.missingItems) {
      parts.push(`- Job #${item.jobId} \`${item.jobName}\`: ${item.reason}`);
    }
    parts.push('');
  }

  if (judgement.formatDeviations.length > 0) {
    parts.push('### Format Deviations');
    parts.push('');
    for (const dev of judgement.formatDeviations) {
      parts.push(`- ${dev}`);
    }
    parts.push('');
  }

  parts.push(
    'After fixing these issues, run get-report one more time to confirm every placeholder is resolved, every target job has a block, and every format rule is satisfied. Do NOT remove content that is already correct.',
  );

  return parts.join('\n');
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
    additionalInstructions: ctx.additionalInstructions,
  });

  const judgeContext = new RequestContext<ReportCompletenessJudgeRequestContext>([
    ['userId', ctx.userId],
    ['aiConfig', ctx.aiConfig],
  ]);

  const generateOptions: Record<string, unknown> = {
    requestContext: judgeContext,
    structuredOutput: {
      schema: reportCompletenessJudgementSchema,
      errorStrategy: 'strict',
    },
  };

  if (ctx.aiConfig.reasoningEffort) {
    generateOptions.modelSettings = { temperature: 1 };
    generateOptions.providerOptions = {
      openai: { reasoningEffort: ctx.aiConfig.reasoningEffort },
    };
  }

  const result = await withRateLimitRetry(
    () => judgeAgent.generate(userPrompt, generateOptions),
    rateLimitRetryConfig,
    { projectId: String(ctx.projectId) },
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
 * 分析 Agent に再実行プロンプトを送信してレポートを補完する
 */
async function rerunAnalysisWithFeedback(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisAgent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  threadId: string;
  feedbackPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraGenerateOptions?: Record<string, any>;
  rateLimitRetryConfig: RateLimitRetryConfig;
}): Promise<{ newThreadId: string }> {
  const {
    analysisAgent,
    summarizationAgent,
    requestContext,
    threadId,
    feedbackPrompt,
    extraGenerateOptions,
    rateLimitRetryConfig,
  } = params;
  const logger = getLogger();
  const ctx = requestContext.all;
  const projectIdStr = String(ctx.projectId);
  const resourceId = ctx.userId;

  let currentThreadId = threadId;
  let prompt = feedbackPrompt;
  let contextLengthRecoveries = 0;
  const MAX_CTX_RECOVERIES = 3;

  while (true) {
    try {
      await withRateLimitRetry(
        () => {
          const generateOptions = {
            ...(extraGenerateOptions ?? {}),
            requestContext,
            memory: { thread: currentThreadId, resource: resourceId },
          };
          return analysisAgent.generate(prompt, generateOptions);
        },
        rateLimitRetryConfig,
        { projectId: projectIdStr },
      );
      return { newThreadId: currentThreadId };
    } catch (error) {
      if (error instanceof RateLimitExhaustedError) {
        throw error;
      }

      const classified = classifyError(error);
      if (classified.type === 'context_length') {
        if (contextLengthRecoveries >= MAX_CTX_RECOVERIES) {
          logger.warn(
            { attempts: contextLengthRecoveries },
            'Pipeline-report completeness rerun context length recovery limit reached',
          );
          return { newThreadId: currentThreadId };
        }
        const recovery = await recoverFromContextLength({
          analysisAgent,
          summarizationAgent,
          threadId: currentThreadId,
          resourceId,
          requestContext,
          rateLimitRetryConfig,
          originalError: error,
        });
        currentThreadId = recovery.newThreadId;
        prompt = `## Context Length Recovery Notice\nThe previous completeness rerun hit a context length limit and was summarized below. Resume the completeness fix immediately.\n\n## Summary of Previous Work\n${recovery.summary}\n\n---\n\n${feedbackPrompt}`;
        contextLengthRecoveries++;
        continue;
      }

      throw error;
    }
  }
}

/**
 * レポートの完全性を検証するステップ
 *
 * 処理フロー:
 * 1. resultFilePath を読む
 * 2. judge agent に渡して判定結果を取得
 * 3. isComplete=true → 完了
 * 4. isComplete=false かつ retries < max →
 *    フィードバックプロンプトを組み立てて analysis agent を再実行 → 再度 verify
 * 5. retries 上限到達 → warning ログを出して現状を返却
 * 6. judge agent が JSON パースエラーになった場合は warning ログを出して現状を返却
 */
export async function verifyCompletenessStep(
  config: VerifyCompletenessStepConfig,
): Promise<VerifyCompletenessStepResult> {
  const logger = getLogger();
  const {
    analysisAgent,
    judgeAgent,
    summarizationAgent,
    requestContext,
    threadId,
    maxCompletenessRetries,
    extraGenerateOptions,
    rateLimitRetryConfig,
  } = config;

  const resultFilePath = requestContext.get('resultFilePath') as string;

  let currentThreadId = threadId;
  let completenessRetries = 0;

  while (true) {
    // 1. 現在のレポートを読む
    const currentReport = await fs.promises.readFile(resultFilePath, 'utf8');

    // 2. judge agent を呼ぶ（パースエラーは warning ログで返却）
    let lastJudgement: ReportCompletenessJudgement;
    try {
      lastJudgement = await callJudgeAgent({
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
        completenessVerified: false,
        completenessRetries,
        lastJudgement: null,
      };
    }

    // 3. 完成
    if (lastJudgement.isComplete) {
      logger.info({ completenessRetries }, 'Pipeline-report completeness verified');
      return {
        reportContent: currentReport,
        completenessVerified: true,
        completenessRetries,
        lastJudgement,
      };
    }

    // 5. 上限到達
    if (completenessRetries >= maxCompletenessRetries) {
      logger.warn(
        {
          completenessRetries,
          missingItems: lastJudgement.missingItems.length,
          formatDeviations: lastJudgement.formatDeviations.length,
        },
        'Pipeline-report completeness retry limit reached, returning current report',
      );
      return {
        reportContent: currentReport,
        completenessVerified: false,
        completenessRetries,
        lastJudgement,
      };
    }

    // 4. フィードバックを組み立てて analysis agent 再実行
    logger.info(
      {
        attempt: completenessRetries + 1,
        missingItems: lastJudgement.missingItems.length,
        formatDeviations: lastJudgement.formatDeviations.length,
      },
      'Pipeline-report not complete; rerunning analysis with feedback',
    );
    const feedbackPrompt = buildCompletenessFeedbackPrompt(lastJudgement);
    const rerunResult = await rerunAnalysisWithFeedback({
      analysisAgent,
      summarizationAgent,
      requestContext,
      threadId: currentThreadId,
      feedbackPrompt,
      extraGenerateOptions,
      rateLimitRetryConfig,
    });
    currentThreadId = rerunResult.newThreadId;
    completenessRetries++;
  }
}
