import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { PipelineAnalysisAgentRequestContext } from '../../requestContext.js';
import { recoverFromContextLength } from './contextLengthRecovery.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../../lib/rateLimitRetry.js';
import { classifyError } from '../../../../lib/errorClassifier.js';
import { RateLimitExhaustedError } from '../../../../lib/rateLimiterGlobal.js';
import { getLogger } from '../../../../lib/logger.js';

/**
 * コンテキスト長リカバリーの最大回数（無限ループ防止）
 * agent 呼び出しは最大 MAX_CONTEXT_LENGTH_RECOVERIES + 1 回（初回 + リカバリー後の継続）
 */
export const MAX_CONTEXT_LENGTH_RECOVERIES = 3;

/**
 * executeAnalysisStep の設定
 */
export interface ExecuteAnalysisStepConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisAgent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  /** system プロンプトで指示された初期 userプロンプト */
  initialUserPrompt: string;
  /** `pipelineAnalysisAgent.generate()` に渡す追加オプション（prepareStep / toolsets など） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraGenerateOptions?: Record<string, any>;
  rateLimitRetryConfig: RateLimitRetryConfig;
}

/**
 * executeAnalysisStep の結果
 */
export interface ExecuteAnalysisStepResult {
  /** 最終的なレポート本文 */
  reportContent: string;
  /** 実際に使用された最終スレッドID */
  finalThreadId: string;
  /** 実行中に発生したコンテキスト長リカバリーの回数 */
  contextLengthRecoveries: number;
}

/**
 * コンテキスト長リカバリー後の継続プロンプトを組み立てる
 *
 * 1. これまでの作業内容が要約されていること
 * 2. 新スレッドで続きから分析を再開するよう指示
 */
export function buildContinuationPrompt(summary: string): string {
  return `## Context Length Recovery Notice
The previous pipeline analysis session was interrupted due to context length limitations. The work history has been summarized below. Please use this summary to continue the analysis of the remaining jobs efficiently.

## Summary of Previous Work
${summary}

---

Continue analyzing the remaining target jobs. Read the current report file with get-report first, then fill in the blocks that are still missing using patch-report (or write-report). Do NOT redo work that is already finalized in the report.`;
}

/**
 * resultFilePath に overallTemplate の初期スケルトンを書き込む
 */
async function writeInitialTemplate(
  resultFilePath: string,
  overallTemplate: string,
): Promise<void> {
  await fs.promises.writeFile(resultFilePath, overallTemplate, 'utf8');
}

/**
 * pipelineAnalysisAgent を呼び出して分析レポートを生成する
 *
 * 処理フロー:
 * 1. resultFilePath に overallTemplate を書き込む（初期スケルトン）
 * 2. pipelineAnalysisAgent.generate() を呼ぶ
 * 3. context length エラー検知 → contextLengthRecovery → リトライ
 * 4. 最大 MAX_CONTEXT_LENGTH_RECOVERIES 回まで 3 を繰り返す
 * 5. 終了後 resultFilePath の内容を文字列で返す
 */
export async function executeAnalysisStep(
  config: ExecuteAnalysisStepConfig,
): Promise<ExecuteAnalysisStepResult> {
  const logger = getLogger();
  const {
    analysisAgent,
    summarizationAgent,
    requestContext,
    initialUserPrompt,
    extraGenerateOptions,
    rateLimitRetryConfig,
  } = config;

  const ctx = requestContext.all;
  const resultFilePath = ctx.resultFilePath;
  const overallTemplate = ctx.overallTemplate;
  const projectIdStr = String(ctx.projectId);
  const resourceId = ctx.userId;

  // 1. 初期テンプレート書き込み
  await writeInitialTemplate(resultFilePath, overallTemplate);

  // スレッド管理: 実行ごとにユニークなthreadIdを生成
  let currentThreadId = randomUUID();
  let prompt = initialUserPrompt;
  let contextLengthRecoveries = 0;

  // 2-4. ループで generate 呼び出し + context length リカバリー
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
      break;
    } catch (error) {
      // レート制限の上限到達 → 呼び出し元に再スロー
      if (error instanceof RateLimitExhaustedError) {
        throw error;
      }

      const classified = classifyError(error);

      if (classified.type === 'context_length') {
        if (contextLengthRecoveries >= MAX_CONTEXT_LENGTH_RECOVERIES) {
          logger.warn(
            { attempts: contextLengthRecoveries },
            'Pipeline-report context length recovery limit reached, returning current report',
          );
          break;
        }

        logger.info(
          { attempt: contextLengthRecoveries + 1 },
          'Pipeline-report context length error detected, attempting recovery',
        );

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
        prompt = buildContinuationPrompt(recovery.summary);
        contextLengthRecoveries++;
        continue;
      }

      // api_call / unknown / その他 → 呼び出し元に再スロー
      throw error;
    }
  }

  // 5. レポート内容を読み取って返却
  const reportContent = await fs.promises.readFile(resultFilePath, 'utf8');
  return {
    reportContent,
    finalThreadId: currentThreadId,
    contextLengthRecoveries,
  };
}
