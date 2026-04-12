import * as fs from 'node:fs';
import type { Agent, MastraDBMessage } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { PipelineAnalysisAgentRequestContext } from '../../requestContext.js';
import { buildGenerateOptions, sanitizeForLog } from '../../../shared/requestContext.js';
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
 *
 * dountil ループから初回・フィードバック再実行の両方で呼び出されるよう汎用化された設計。
 * テンプレート書き込みは呼び出し元（prepare step）の責務とし、本関数は generate ループに専念する。
 */
export interface ExecuteAnalysisStepConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisAgent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  /** このターンに送信するプロンプト（初回=初期プロンプト、再実行=feedback prompt with report） */
  currentPrompt: string;
  /** 使用するスレッドID。呼び出し元が決定する */
  threadId: string;
  /**
   * context length recovery 時に continuation prompt の先頭に prepend する基礎プロンプト。
   * リカバリー後に初期ユーザプロンプト（パイプラインコンテキスト全量）を復元するために渡される。
   */
  initialUserPromptForRecovery: string;
  /**
   * feedback 再実行中の場合、リカバリー後の continuation prompt 末尾に付与する追加指示。
   * 初回実行時は null。
   */
  feedbackPromptForRecovery: string | null;
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
  /** 実際に使用された最終スレッドID（context length recovery で変化しうる） */
  finalThreadId: string;
  /** 実行中に発生したコンテキスト長リカバリーの回数 */
  contextLengthRecoveries: number;
}

/**
 * context length recovery 後の継続プロンプトを構築する
 *
 * 構造（review 機能の buildContinuationPrompt と同パターン + レポート現物）:
 *   1. 初期ユーザプロンプト（パイプラインコンテキスト全量）
 *   2. レポート現物（どこまで完成しているかの提示）
 *   3. Context Length Recovery Notice + Summary of Previous Work
 *   4. （feedback 再実行中の場合）Completeness Review Feedback
 *   5. 続行指示
 */
export function buildContinuationPrompt(
  initialUserPrompt: string,
  currentReportContent: string,
  summary: string,
  feedbackPrompt: string | null,
): string {
  const feedbackSection = feedbackPrompt ? `\n\n---\n\n${feedbackPrompt}` : '';
  return `${initialUserPrompt}

---

## Current Report Progress
Below is the current state of the report file. Use this to understand what has been completed and what still needs work. Do NOT redo work that is already finalized.

\`\`\`markdown
${currentReportContent}
\`\`\`

---

## Context Length Recovery Notice
The previous pipeline analysis session was interrupted due to context length limitations. The work history has been summarized below. Please use this summary to continue the analysis of the remaining jobs efficiently. The base task context and current report have been re-attached above.

## Summary of Previous Work
${summary}${feedbackSection}

---

Continue analyzing the remaining target jobs. Fill in the blocks that are still missing using patch-report (or write-report).`;
}

/**
 * レート制限リカバリー後の継続プロンプトを構築する
 *
 * review機能の buildRateLimitContinuationPrompt と同パターン。
 * チェック項目（review機能）の代わりにレポート状態は会話履歴から参照可能なため、
 * 連続レート制限時のコンテキスト肥大化を防ぐため簡潔な固定文面とする。
 */
export function buildRateLimitContinuationPrompt(): string {
  return `## Rate Limit Recovery Notice
The previous operation was interrupted due to a rate limit error. The conversation history is preserved.

Please resume analyzing the remaining target jobs. Continue filling in the report using patch-report (or write-report).`;
}

/**
 * メモリから取得したメッセージ配列の末尾メッセージが、
 * `buildRateLimitContinuationPrompt()` と完全一致する `user` メッセージかを判定する。
 *
 * 連続レート制限（直前のリトライで既に継続プロンプトを送信済み）を検知するために使用する。
 * 一致した場合はそのメッセージのIDを返し、呼び出し側で `memory.deleteMessages` により
 * 重複する継続プロンプトを削除できる。
 */
export function getLastRateLimitContinuationMessageId(messages: MastraDBMessage[]): string | null {
  if (messages.length === 0) {
    return null;
  }
  const last = messages[messages.length - 1];
  if (last.role !== 'user') {
    return null;
  }
  const text = extractTextFromMessage(last);
  if (text === null) {
    return null;
  }
  if (text !== buildRateLimitContinuationPrompt()) {
    return null;
  }
  return last.id;
}

/**
 * `MastraDBMessage` からテキスト本文を抽出する。
 *
 * `content.parts` 先頭の `text` パートを優先し、無ければ `content.content` にフォールバックする。
 * いずれも取得できない場合は `null` を返す。
 */
function extractTextFromMessage(message: MastraDBMessage): string | null {
  const parts = message.content.parts;
  if (parts && parts.length > 0) {
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  if (typeof message.content.content === 'string') {
    return message.content.content;
  }
  return null;
}

/**
 * pipelineAnalysisAgent を呼び出して分析レポートを生成する
 *
 * dountil ループ内から初回実行・フィードバック再実行の両方で使われる汎用関数。
 *
 * 処理フロー:
 * 1. pipelineAnalysisAgent.generate() を呼ぶ
 * 2. context length エラー検知 → contextLengthRecovery → リトライ
 * 3. 最大 MAX_CONTEXT_LENGTH_RECOVERIES 回まで 2 を繰り返す
 * 4. 終了後 resultFilePath の内容を文字列で返す
 */
export async function executeAnalysisStep(
  config: ExecuteAnalysisStepConfig,
): Promise<ExecuteAnalysisStepResult> {
  const logger = getLogger();
  const {
    analysisAgent,
    summarizationAgent,
    requestContext,
    currentPrompt,
    initialUserPromptForRecovery,
    feedbackPromptForRecovery,
    extraGenerateOptions,
    rateLimitRetryConfig,
  } = config;

  const ctx = requestContext.all;
  const resultFilePath = ctx.resultFilePath;
  const projectIdStr = ctx.projectId;
  const resourceId = ctx.userId;

  let currentThreadId: string = config.threadId;
  let prompt = currentPrompt;
  let contextLengthRecoveries = 0;

  // generate 呼び出し + context length リカバリーのループ
  while (true) {
    try {
      // withRateLimitRetryでレート制限制御を統合
      // - per-agentリトライ回数はwithRateLimitRetry内のlocalRetryCountで管理
      // - onRateLimitHitで同一スレッドの継続プロンプトに差し替え
      await withRateLimitRetry(
        () => {
          logger.debug(
            { requestContext: sanitizeForLog(requestContext.all) },
            'Calling pipelineAnalysisAgent.generate',
          );
          const generateOptions = {
            ...(extraGenerateOptions ?? {}),
            requestContext,
            memory: { thread: currentThreadId, resource: resourceId },
            ...buildGenerateOptions(ctx.openaiReasoningEffort),
          };
          return analysisAgent.generate(prompt, generateOptions);
        },
        rateLimitRetryConfig,
        {
          projectId: projectIdStr,
          onRateLimitHit: async () => {
            // 連続レート制限（直前のリトライで既に同じ継続プロンプトを送信済み）を検知し、
            // メモリ履歴に積まれた重複プロンプトを削除してから再送する。
            // これによりメモリには継続プロンプトが常に最大1件しか積まれない。
            try {
              const memory = await analysisAgent.getMemory();
              if (memory) {
                // NOTE: memory.recall() のデフォルトは perPage=40 のページネーション。
                // 長時間稼働で履歴が40件を超えた後の重複継続プロンプトを検知するため
                // perPage: false で全件取得する必要がある。
                const recalled = await memory.recall({
                  threadId: currentThreadId,
                  perPage: false,
                });
                const duplicateId = getLastRateLimitContinuationMessageId(recalled.messages);
                if (duplicateId !== null) {
                  try {
                    await memory.deleteMessages([duplicateId]);
                  } catch (err) {
                    logger.warn(
                      { err },
                      'Failed to delete previous rate limit continuation message; proceeding without dedupe',
                    );
                  }
                }
              }
            } catch (err) {
              logger.debug(
                { err },
                'Failed to inspect memory for consecutive rate limit detection',
              );
            }
            // 同じスレッドで簡潔な継続プロンプトを送信
            prompt = buildRateLimitContinuationPrompt();
          },
        },
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

        // レポートの現在状態を読み取り、continuation prompt に含める
        const currentReportContent = await fs.promises.readFile(resultFilePath, 'utf8');

        currentThreadId = recovery.newThreadId;
        prompt = buildContinuationPrompt(
          initialUserPromptForRecovery,
          currentReportContent,
          recovery.summary,
          feedbackPromptForRecovery,
        );
        contextLengthRecoveries++;
        continue;
      }

      // api_call / unknown / その他 → 呼び出し元に再スロー
      throw error;
    }
  }

  // レポート内容を読み取って返却
  const reportContent = await fs.promises.readFile(resultFilePath, 'utf8');
  return {
    reportContent,
    finalThreadId: currentThreadId,
    contextLengthRecoveries,
  };
}
