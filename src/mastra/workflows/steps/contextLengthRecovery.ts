import { randomUUID } from 'node:crypto';
import type { Agent, MastraDBMessage } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';
import type {
  ReviewAgentRequestContext,
  SummarizationAgentRequestContext,
} from '../../requestContext.js';
import { readStoredResults } from '../../types.js';
import { buildSummarizationUserPrompt } from '../../agents/summarizationAgent.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../lib/rateLimitRetry.js';
import { getLogger } from '../../../lib/logger.js';

/**
 * シリアライズ後の文字数上限
 * 超過時はメッセージ数ベースの中間カットを実行する
 * 要約Agent自体がコンテキスト長エラーにならないよう、一般的なモデルの上限（約128kトークン）に対して十分な余裕を持たせた値
 */
export const MAX_SERIALIZED_CHARS = 80000;

/**
 * コンテキスト長リカバリーの設定
 */
export interface ContextLengthRecoveryConfig {
  reviewAgent: Agent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  threadId: string;
  resourceId: string;
  requestContext: RequestContext<ReviewAgentRequestContext>;
  checkItems: IndexedCheckItem[];
  resultFilePath: string;
  rateLimitRetryConfig: RateLimitRetryConfig;
}

/**
 * コンテキスト長リカバリーの結果
 */
export interface ContextLengthRecoveryResult {
  newThreadId: string;
  summary: string;
}

/**
 * メッセージ配列をテキスト形式にシリアライズする
 *
 * 全メッセージをシリアライズし、文字数上限を超える場合は
 * メッセージ数ベースの中間カット（先頭10%＋末尾50%）を実行する。
 */
export function serializeMessages(
  messages: MastraDBMessage[],
  maxChars: number = MAX_SERIALIZED_CHARS,
): { text: string; wasTrimmed: boolean } {
  if (messages.length === 0) {
    return { text: '', wasTrimmed: false };
  }

  // 全メッセージをシリアライズ
  const serialized = messages.map(serializeSingleMessage);
  const fullText = serialized.join('\n\n');

  // 上限以内ならそのまま返す
  if (fullText.length <= maxChars) {
    return { text: fullText, wasTrimmed: false };
  }

  // メッセージ数ベースの中間カット
  const totalCount = messages.length;
  const headCount = Math.max(1, Math.ceil(totalCount * 0.1));
  const tailCount = Math.max(1, Math.ceil(totalCount * 0.5));

  // 重複を避ける（headとtailが重なる場合は全メッセージを保持）
  if (headCount + tailCount >= totalCount) {
    return { text: fullText, wasTrimmed: false };
  }

  const headMessages = serialized.slice(0, headCount);
  const tailMessages = serialized.slice(totalCount - tailCount);
  const omittedCount = totalCount - headCount - tailCount;

  const trimmedText = [
    ...headMessages,
    `\n[NOTE: ${omittedCount} messages from the middle of the conversation were omitted due to length constraints. The oldest 10% and newest 50% of messages are preserved.]\n`,
    ...tailMessages,
  ].join('\n\n');

  return { text: trimmedText, wasTrimmed: true };
}

/**
 * 単一メッセージをテキストにシリアライズする
 */
function serializeSingleMessage(message: MastraDBMessage): string {
  const parts: string[] = [];
  parts.push(`[${message.role}]`);

  if (message.content.parts.length > 0) {
    for (const part of message.content.parts) {
      if (part.type === 'text' && part.text) {
        parts.push(part.text);
      } else if (part.type === 'tool-invocation') {
        const inv = part.toolInvocation;
        const argsStr = inv.args ? JSON.stringify(inv.args) : '';
        // ツール結果はstate='result'の場合のみ存在する（tool-invocationパートに統合されている）
        const resultStr =
          inv.state === 'result' && inv.result
            ? String(typeof inv.result === 'object' ? JSON.stringify(inv.result) : inv.result)
            : '';
        parts.push(`[Tool: ${inv.toolName}]`);
        if (argsStr) parts.push(`  Args: ${argsStr}`);
        if (resultStr) parts.push(`  Result: ${resultStr}`);
      }
      // text・tool-invocation以外のパートタイプ（reasoning, source, file, step-start等）は無視
    }
  } else if (message.content.content) {
    // fallback: content文字列がある場合
    parts.push(String(message.content.content));
  }

  return parts.join('\n');
}

/**
 * レビュー済み結果の概要文字列を構築する
 */
function buildAlreadyStoredSummary(checkItems: IndexedCheckItem[], resultFilePath: string): string {
  const storedResults = readStoredResults(resultFilePath);
  if (storedResults.length === 0) {
    return 'None yet';
  }

  return storedResults
    .map((r) => {
      const item = checkItems.find((i) => i.id === r.checkItemId);
      const content = item ? item.content : `Unknown (ID: ${r.checkItemId})`;
      return `[ID: ${r.checkItemId}] ${content} - ${r.ratingLabel}`;
    })
    .join('\n');
}

/**
 * コンテキスト長エラーからリカバリーする
 *
 * 処理フロー:
 * 1. レビュー済み結果を取得
 * 2. メモリからスレッドメッセージを取得
 * 3. メッセージをシリアライズ
 * 4. 要約Agent用のRequestContextを構築
 * 5. 要約Agentで会話履歴を要約
 * 6. 旧スレッドを削除
 * 7. 新しいthreadIdと要約テキストを返す
 */
export async function recoverFromContextLength(
  config: ContextLengthRecoveryConfig,
): Promise<ContextLengthRecoveryResult> {
  const logger = getLogger();
  const {
    reviewAgent,
    summarizationAgent,
    threadId,
    requestContext,
    checkItems,
    resultFilePath,
    rateLimitRetryConfig,
  } = config;

  logger.info({ threadId }, 'Starting context length recovery');

  // 1. レビュー済み結果の概要を構築
  const alreadyStoredSummary = buildAlreadyStoredSummary(checkItems, resultFilePath);

  // 2. メモリからスレッドメッセージを取得
  const memory = await reviewAgent.getMemory();
  let messages: MastraDBMessage[] = [];
  if (memory) {
    const recalled = await memory.recall({ threadId });
    messages = recalled.messages;
  }

  // 3. メッセージをシリアライズ
  const { text: serializedText, wasTrimmed } = serializeMessages(messages);

  // 4. 要約Agent用のRequestContextを構築
  const reviewCtx = requestContext.all;
  const summarizationContext = new RequestContext<SummarizationAgentRequestContext>([
    ['userId', reviewCtx.userId],
    ['aiApiKey', reviewCtx.aiApiKey],
    ['aiApiEndpointUrl', reviewCtx.aiApiEndpointUrl],
    ['aiModelName', reviewCtx.aiModelName],
    ['projectDir', reviewCtx.projectDir],
    ['checkItems', checkItems],
    ['mrTitle', reviewCtx.mrTitle],
    ['mrSourceBranch', reviewCtx.mrSourceBranch],
    ['mrTargetBranch', reviewCtx.mrTargetBranch],
    ['alreadyStoredSummary', alreadyStoredSummary],
  ]);

  // 5. 要約Agentで会話履歴を要約
  const userPrompt = buildSummarizationUserPrompt(serializedText, wasTrimmed);
  const result = await withRateLimitRetry(
    () =>
      summarizationAgent.generate(userPrompt, {
        requestContext: summarizationContext,
      }),
    rateLimitRetryConfig,
  );

  const summary = typeof result.text === 'string' ? result.text : String(result.text);

  // 6. 旧スレッドを削除
  if (memory) {
    try {
      await memory.deleteThread(threadId);
    } catch {
      // スレッド削除失敗は無視
      logger.warn({ threadId }, 'Failed to delete old thread during context length recovery');
    }
  }

  // 7. 新しいthreadIdと要約テキストを返す
  const newThreadId = randomUUID();
  logger.info({ oldThreadId: threadId, newThreadId }, 'Context length recovery completed');

  return { newThreadId, summary };
}
