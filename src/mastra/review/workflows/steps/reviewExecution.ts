import { randomUUID } from 'node:crypto';
import type { Agent, MastraDBMessage } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';
import { ReviewResult } from '../../../../domain/review/reviewResult/index.js';
import { Rating } from '../../../../domain/review/rating/index.js';
import { CheckItem } from '../../../../domain/review/checkItem/index.js';
import type { ReviewAgentRequestContext } from '../../requestContext.js';
import { buildGenerateOptions, sanitizeForLog } from '../../../shared/requestContext.js';
import { readStoredResults, type StoredReviewResult } from '../../types.js';
import { buildUserPrompt, buildPrepareStepForImageInjection } from '../../agents/reviewAgent.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../../lib/rateLimitRetry.js';
import { classifyError, REVIEW_MISSED_MESSAGE } from '../../../../lib/errorClassifier.js';
import { recoverFromContextLength } from './contextLengthRecovery.js';
import { getLogger } from '../../../../lib/logger.js';
import { RateLimitExhaustedError } from '../../../../lib/rateLimiterGlobal.js';

/**
 * レビュー実行ステップの設定
 *
 * ratings, commentFormat, additionalInstructions, mrContext, priorReviewContext は
 * RequestContext経由でAgentに渡されるため、このConfigには含めない。
 */
export interface ReviewExecutionConfig {
  checkItems: IndexedCheckItem[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<ReviewAgentRequestContext>;
  resultFilePath: string;
  rateLimitRetryConfig: RateLimitRetryConfig;
}

/**
 * リトライの最大回数（漏れチェック用）
 */
const MAX_RETRIES = 2;

/**
 * コンテキスト長リカバリーの最大回数（無限ループ防止）
 * generate呼び出しは最大 MAX_CONTEXT_LENGTH_RECOVERIES + 1 回（初回 + リカバリー回数分の継続）
 */
const MAX_CONTEXT_LENGTH_RECOVERIES = 3;

/**
 * 部分的成功を保持して、未完了項目のみエラーにする
 */
function buildResults(
  checkItems: IndexedCheckItem[],
  storedResults: StoredReviewResult[],
  defaultErrorMessage: string,
): ReviewResult[] {
  return checkItems.map((item) => {
    const stored = storedResults.find((r) => r.checkItemId === item.id);
    const checkItem = new CheckItem(item.content);
    if (!stored) {
      return ReviewResult.error(checkItem, defaultErrorMessage);
    }
    if (stored.isError) {
      return ReviewResult.error(checkItem, stored.errorMessage ?? 'Unknown error');
    }
    return ReviewResult.success(
      checkItem,
      new Rating(stored.ratingLabel, stored.ratingDefinition),
      stored.comment,
    );
  });
}

/**
 * レート制限リカバリー後の継続プロンプトを構築する
 *
 * 同じスレッドに送信するため、会話履歴はメモリで保持されている。
 * エージェントに「中断されたので再開してください」と伝えるだけでよい。
 * チェック項目は会話履歴から参照可能なため、ここでは含めない（連続レート制限時の
 * コンテキスト肥大化を防ぐため簡潔な固定文面とする）。
 */
export function buildRateLimitContinuationPrompt(): string {
  return `## Rate Limit Recovery Notice
The previous operation was interrupted due to a rate limit error. The conversation history is preserved.

Please resume reviewing the remaining check items. Store each result using the storeReviewResult tool.`;
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
 * コンテキスト長リカバリー後のレビュー継続用プロンプトを構築する
 *
 * PBI指定の構成:
 * 1. 通常通りのuserプロンプト（MR情報、diff等）
 * 2. 現状レビュー済みのチェック項目
 * 3. コンテキスト逼迫により今までの作業内容を要約した旨
 * 4. 要約内容
 */
export function buildContinuationPrompt(
  requestContext: RequestContext<ReviewAgentRequestContext>,
  summary: string,
  alreadyReviewedItemIds: number[],
): string {
  const ctx = requestContext.all;

  // レビュー済み項目のリスト構築
  const reviewedList =
    alreadyReviewedItemIds.length > 0
      ? alreadyReviewedItemIds
          .map((id) => {
            const item = ctx.checkItems.find((i) => i.id === id);
            return item ? `- [ID: ${id}] ${item.content}` : `- [ID: ${id}] (unknown)`;
          })
          .join('\n')
      : 'None';

  // 1. 通常通りのuserプロンプト
  const basePrompt = buildUserPrompt(requestContext);

  return `${basePrompt}

---

## Already Reviewed Items
The following items have already been reviewed and their results stored. You do NOT need to review them again:
${reviewedList}

## Context Length Recovery Notice
The previous review session was interrupted due to context length limitations. The work history has been summarized below. Please use this summary to continue reviewing the remaining items efficiently.

## Summary of Previous Work
${summary}

---

Continue reviewing the remaining check items. Store each result using the storeReviewResult tool.`;
}

/**
 * Agent呼び出しをエラーリカバリー付きで実行する
 *
 * 以下のエラーをループ内で処理する:
 * - レート制限: レートリミッター経由で待機 → 同じスレッドで継続プロンプト送信
 * - コンテキスト長: 要約 → 新スレッド → 継続プロンプト（最大MAX_CONTEXT_LENGTH_RECOVERIES回）
 * - RateLimitExhaustedError: 呼び出し元に再スロー（グローバル上限到達）
 * - その他: 呼び出し元に再スロー
 */
async function executeWithErrorRecovery(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  initialPrompt: string;
  requestContext: RequestContext<ReviewAgentRequestContext>;
  memoryOption: { thread: string; resource: string };
  checkItems: IndexedCheckItem[];
  rateLimitRetryConfig: RateLimitRetryConfig;
  allThreadIds: string[];
}): Promise<{ currentThreadId: string }> {
  const logger = getLogger();
  let { initialPrompt: prompt, memoryOption } = params;
  const {
    agent,
    summarizationAgent,
    requestContext,
    checkItems,
    rateLimitRetryConfig,
    allThreadIds,
  } = params;
  const resultFilePath = String(requestContext.get('resultFilePath'));
  const projectId = String(requestContext.get('projectId'));
  let currentThreadId = memoryOption.thread;
  let contextLengthRecoveries = 0;

  while (true) {
    try {
      // withRateLimitRetryでレート制限制御を統合
      // - per-agentリトライ回数はwithRateLimitRetry内のlocalRetryCountで管理
      // - onRateLimitHitで同一スレッドの継続プロンプトに差し替え
      await withRateLimitRetry(
        () => {
          logger.debug(
            { requestContext: sanitizeForLog(requestContext.all) },
            'Calling reviewAgent.generate',
          );
          return agent.generate(prompt, {
            requestContext,
            memory: memoryOption,
            maxSteps: 50,
            prepareStep: buildPrepareStepForImageInjection(requestContext),
            ...buildGenerateOptions(requestContext.all),
          });
        },
        rateLimitRetryConfig,
        {
          projectId,
          onRateLimitHit: async () => {
            // 連続レート制限（直前のリトライで既に同じ継続プロンプトを送信済み）を検知し、
            // メモリ履歴に積まれた重複プロンプトを削除してから再送する。
            // これによりメモリには継続プロンプトが常に最大1件しか積まれない。
            try {
              const memory = await agent.getMemory();
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
      return { currentThreadId };
    } catch (error) {
      // per-agentリトライ上限到達 → 呼び出し元に再スロー
      if (error instanceof RateLimitExhaustedError) {
        throw error;
      }

      const classified = classifyError(error);

      if (classified.type === 'context_length') {
        if (contextLengthRecoveries >= MAX_CONTEXT_LENGTH_RECOVERIES) {
          logger.warn('Context length recovery limit reached, proceeding with partial results');
          return { currentThreadId };
        }

        logger.info(
          { attempt: contextLengthRecoveries + 1 },
          'Context length error detected, attempting recovery',
        );

        // リカバリー実行（リカバリー自体の失敗は呼び出し元でunknownエラーとして処理される）
        let recovery: Awaited<ReturnType<typeof recoverFromContextLength>>;
        try {
          recovery = await recoverFromContextLength({
            reviewAgent: agent,
            summarizationAgent,
            threadId: currentThreadId,
            resourceId: memoryOption.resource,
            requestContext,
            checkItems,
            rateLimitRetryConfig,
            originalError: error,
          });
        } catch (recoveryError) {
          logger.error(
            { err: recoveryError, attempt: contextLengthRecoveries + 1 },
            'Context length recovery failed',
          );
          throw recoveryError;
        }

        allThreadIds.push(recovery.newThreadId);
        currentThreadId = recovery.newThreadId;
        memoryOption = { thread: recovery.newThreadId, resource: memoryOption.resource };
        contextLengthRecoveries++;

        // レビュー済みチェック項目IDを取得
        const storedResults = readStoredResults(resultFilePath);
        const alreadyReviewedItemIds = storedResults.map((r) => r.checkItemId);

        // 継続プロンプトを構築
        prompt = buildContinuationPrompt(requestContext, recovery.summary, alreadyReviewedItemIds);
        continue;
      }

      // api_call or unknown → 呼び出し元に再スロー
      throw error;
    }
  }
}

/**
 * レビュー実行のコアロジック
 *
 * シングルトンのレビューエージェントにRequestContextを渡してレビューを実行する。
 * 結果はエージェントがstoreReviewResultツールを使ってファイルに保存する。
 * 漏れがある場合は最大2回リトライし、それでも漏れがある場合はエラー結果を返す。
 * メモリ（threadId）により、リトライ時に初回の会話履歴が保持される。
 *
 * エラーハンドリング:
 * - レート制限エラー: バックオフ待機後、同じスレッドで継続プロンプトを送信（最大rateLimitRetryConfig.maxRetries回）
 * - コンテキスト長エラー: 作業履歴を要約して継続（最大3回ループ）
 * - API呼び出しエラー: 部分結果を保持し、未完了項目にエラーメッセージを表示
 * - その他エラー: 部分結果を保持し、未完了項目に定型メッセージを表示
 */
export async function executeReview(config: ReviewExecutionConfig): Promise<ReviewResult[]> {
  const {
    checkItems,
    agent,
    summarizationAgent,
    requestContext,
    resultFilePath,
    rateLimitRetryConfig,
  } = config;

  // スレッド管理: 実行ごとにユニークなthreadIdを生成
  let threadId: string = randomUUID();
  const resourceId = String(requestContext.get('userId'));
  let memoryOption = { thread: threadId, resource: resourceId };
  const allThreadIds: string[] = [threadId];

  try {
    // 初回のエージェント実行（エラーリカバリーループ付き）
    const prompt = buildUserPrompt(requestContext);

    try {
      const result = await executeWithErrorRecovery({
        agent,
        summarizationAgent,
        initialPrompt: prompt,
        requestContext,
        memoryOption,
        checkItems,
        rateLimitRetryConfig,
        allThreadIds,
      });
      threadId = result.currentThreadId;
      memoryOption = { thread: threadId, resource: resourceId };
    } catch (error) {
      // リカバリー不能なエラー（API/その他、レート制限上限到達含む）→ 部分結果を保持
      const classified = classifyError(error);
      const logger = getLogger();
      // エラー内容をログに出力（ユーザには定型メッセージを表示するが、ログには詳細を残す）
      logger.error(
        { err: error, errorType: classified.type },
        'Review execution failed with unrecoverable error',
      );
      const storedResults = readStoredResults(resultFilePath);
      return buildResults(checkItems, storedResults, classified.message);
    }

    // 漏れチェックとリトライ
    let storedResults = readStoredResults(resultFilePath);

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      const missingItems = checkItems.filter(
        (item) => !storedResults.some((r) => r.checkItemId === item.id),
      );

      if (missingItems.length === 0) {
        break;
      }

      // 漏れた項目についてリトライ（エラーリカバリーループ付き）
      try {
        const retryPrompt = `The following check items are still missing results. Please review them and store results using the storeReviewResult tool:\n${missingItems.map((i) => `- [ID: ${i.id}] ${i.content}`).join('\n')}`;
        const result = await executeWithErrorRecovery({
          agent,
          summarizationAgent,
          initialPrompt: retryPrompt,
          requestContext,
          memoryOption,
          checkItems,
          rateLimitRetryConfig,
          allThreadIds,
        });
        threadId = result.currentThreadId;
        memoryOption = { thread: threadId, resource: resourceId };
        storedResults = readStoredResults(resultFilePath);
      } catch (error) {
        // リトライ失敗時はエラー種別に応じたメッセージで即座に返す
        // リトライ中に格納された結果を反映するため再読み込み
        const logger = getLogger();
        const classified = classifyError(error);
        logger.error({ err: error, errorType: classified.type }, 'Retry review execution failed');
        storedResults = readStoredResults(resultFilePath);
        return buildResults(checkItems, storedResults, classified.message);
      }
    }

    // 結果をReviewResultに変換（部分的成功を保持）
    return buildResults(checkItems, storedResults, REVIEW_MISSED_MESSAGE);
  } finally {
    // 全スレッドをクリーンアップ
    try {
      const memory = await agent.getMemory();
      if (memory) {
        for (const tid of allThreadIds) {
          try {
            await memory.deleteThread(tid);
          } catch {
            // クリーンアップ失敗は無視
          }
        }
      }
    } catch {
      // クリーンアップ失敗は無視（CI/CD隔離環境でジョブ終了時に破棄される）
    }
  }
}
