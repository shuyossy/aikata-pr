import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent, MastraDBMessage, MastraMessagePart } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';
import type {
  ReviewAgentRequestContext,
  SummarizationAgentRequestContext,
} from '../../requestContext.js';
import { buildGenerateOptions, sanitizeForLog } from '../../requestContext.js';
import { readStoredResults } from '../../types.js';
import { buildSummarizationUserPrompt } from '../../agents/summarizationAgent.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../lib/rateLimitRetry.js';
import { getLogger } from '../../../lib/logger.js';
import { isImageCountExceededError } from '../../../lib/aiApiError.js';
import { IMAGE_MESSAGE_PREFIX } from '../../tools/readImage.js';

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
  rateLimitRetryConfig: RateLimitRetryConfig;
  originalError?: unknown;
}

/**
 * コンテキスト長リカバリーの結果
 */
export interface ContextLengthRecoveryResult {
  newThreadId: string;
  summary: string;
}

/**
 * シリアライズ時に抽出された画像データ
 */
export interface ExtractedImageData {
  filePath: string;
  base64Data: string;
  mediaType: string;
}

/**
 * メッセージ配列をテキスト形式にシリアライズする
 *
 * 全メッセージをシリアライズし、文字数上限を超える場合は
 * メッセージ数ベースの中間カット（先頭10%＋末尾50%）を実行する。
 * readImageツールの呼び出し結果から画像データを抽出し、プレースホルダーに置換する。
 */
export function serializeMessages(
  messages: MastraDBMessage[],
  maxChars: number = MAX_SERIALIZED_CHARS,
): { text: string; wasTrimmed: boolean; imageData: ExtractedImageData[] } {
  const imageData: ExtractedImageData[] = [];

  if (messages.length === 0) {
    return { text: '', wasTrimmed: false, imageData };
  }

  // 全メッセージをシリアライズ
  const serialized = messages.map((msg) => serializeSingleMessage(msg, imageData));
  const fullText = serialized.join('\n\n');

  // 上限以内ならそのまま返す
  if (fullText.length <= maxChars) {
    return { text: fullText, wasTrimmed: false, imageData };
  }

  // メッセージ数ベースの中間カット
  const totalCount = messages.length;
  const headCount = Math.max(1, Math.ceil(totalCount * 0.1));
  const tailCount = Math.max(1, Math.ceil(totalCount * 0.5));

  // 重複を避ける（headとtailが重なる場合は全メッセージを保持）
  if (headCount + tailCount >= totalCount) {
    return { text: fullText, wasTrimmed: false, imageData };
  }

  const headMessages = serialized.slice(0, headCount);
  const tailMessages = serialized.slice(totalCount - tailCount);
  const omittedCount = totalCount - headCount - tailCount;

  const trimmedText = [
    ...headMessages,
    `\n[NOTE: ${omittedCount} messages from the middle of the conversation were omitted due to length constraints. The oldest 10% and newest 50% of messages are preserved.]\n`,
    ...tailMessages,
  ].join('\n\n');

  return { text: trimmedText, wasTrimmed: true, imageData };
}

/**
 * prepareStepで注入されたuserメッセージ内の画像パートからファイルパスと画像データを抽出する
 * userメッセージのcontent配列内のimageパートとtextパートからファイルパスリストを照合する
 *
 * prepareStepが注入するuserメッセージの構造:
 * - content[0]: text（IMAGE_MESSAGE_PREFIXで始まるテキスト + ファイルパスリスト）
 * - content[1..N]: image（base64画像データ）
 */
/**
 * 画像/ファイルパートからbase64データを抽出するヘルパー
 * MastraMessagePartはimageやdataプロパティを型定義上持たないため、
 * ランタイムで存在するプロパティをRecord型経由で安全にアクセスする
 */
function extractBase64FromPart(part: MastraMessagePart): string {
  const raw = part as Record<string, unknown>;
  if (typeof raw.image === 'string') return raw.image;
  if (raw.image instanceof Buffer) return raw.image.toString('base64');
  if (typeof raw.data === 'string') return raw.data;
  return '';
}

/**
 * 画像/ファイルパートからmediaTypeを抽出するヘルパー
 */
function extractMediaType(part: MastraMessagePart): string {
  const raw = part as Record<string, unknown>;
  if (typeof raw.mimeType === 'string') return raw.mimeType;
  if (typeof raw.mediaType === 'string') return raw.mediaType;
  return 'image/png';
}

function extractImagesFromUserMessage(
  parts: MastraMessagePart[],
  imageData: ExtractedImageData[],
): boolean {
  // textパートからファイルパスリストを抽出
  const textPart = parts.find((p) => p.type === 'text' && typeof p.text === 'string');
  if (!textPart || textPart.type !== 'text' || !textPart.text?.includes(IMAGE_MESSAGE_PREFIX)) {
    return false;
  }

  // テキストからファイルパスを抽出（"1. path/to/file.png" 形式）
  const filePathPattern = /^\d+\.\s+(.+)$/gm;
  const filePaths: string[] = [];
  let match;
  while ((match = filePathPattern.exec(textPart.text)) !== null) {
    filePaths.push(match[1]);
  }

  // fileパート（画像データ）を抽出
  const imageParts = parts.filter((p) => p.type === 'file');

  // ファイルパスと画像パートを対応付けて抽出
  for (let i = 0; i < imageParts.length; i++) {
    const imgPart = imageParts[i];
    const filePath = filePaths[i] ?? `image-${i}`;
    const base64Data = extractBase64FromPart(imgPart);
    const mediaType = extractMediaType(imgPart);

    if (base64Data) {
      imageData.push({ filePath, base64Data, mediaType });
    }
  }

  return imageParts.length > 0;
}

/**
 * 単一メッセージをテキストにシリアライズする
 * prepareStepで注入された画像付きuserメッセージは画像データを抽出してプレースホルダーに置換する
 */
function serializeSingleMessage(message: MastraDBMessage, imageData: ExtractedImageData[]): string {
  const parts: string[] = [];
  parts.push(`[${message.role}]`);

  if (message.content.parts.length > 0) {
    // prepareStepで注入された画像付きuserメッセージを検出
    if (message.role === 'user' && extractImagesFromUserMessage(message.content.parts, imageData)) {
      // 画像付きuserメッセージ: テキストパートのみ保持し、画像パートはプレースホルダーに置換
      for (const part of message.content.parts) {
        if (part.type === 'text' && part.text) {
          parts.push(part.text);
        }
      }
      // 抽出された各画像のプレースホルダーを追加
      const newImages = imageData.slice(
        -message.content.parts.filter((p) => p.type === 'file').length,
      );
      for (const img of newImages) {
        parts.push(`  [Image: ${img.filePath}]`);
      }
      return parts.join('\n');
    }

    for (const part of message.content.parts) {
      if (part.type === 'text' && part.text) {
        parts.push(part.text);
      } else if (part.type === 'tool-invocation') {
        const inv = part.toolInvocation;
        const argsStr = inv.args ? JSON.stringify(inv.args) : '';

        // 通常のツール結果シリアライズ
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
 * 画像数超過時にシリアライズテキスト内の画像プレースホルダーをファイル名のみに置換する
 */
function replaceImagePlaceholdersWithFilenames(
  text: string,
  imageData: ExtractedImageData[],
): string {
  let result = text;
  for (const img of imageData) {
    const filename = path.basename(img.filePath);
    result = result.replace(
      `[Image: ${img.filePath}]`,
      `[Image: ${filename} - image data excluded due to image count limit]`,
    );
  }
  return result;
}

/**
 * コンテキスト長エラーからリカバリーする
 *
 * 処理フロー:
 * 1. レビュー済み結果を取得
 * 2. メモリからスレッドメッセージを取得
 * 3. メッセージをシリアライズ（画像データを抽出）
 * 4. 要約Agent用のRequestContextを構築
 * 5. 要約Agentで会話履歴を要約（画像対応）
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
    rateLimitRetryConfig,
    originalError,
  } = config;
  const resultFilePath = String(requestContext.get('resultFilePath'));

  const projectId = String(requestContext.get('projectId'));

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

  // 3. メッセージをシリアライズ（画像データを抽出）
  const { text: serializedText, wasTrimmed, imageData } = serializeMessages(messages);

  // 画像数超過エラーかどうかを判定
  const imageCountExceeded = originalError ? isImageCountExceededError(originalError) : false;
  const hasImages = imageData.length > 0 && !imageCountExceeded;

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
    ['openaiReasoningEffort', reviewCtx.openaiReasoningEffort],
    ['hasImages', hasImages],
  ]);

  // 5. 要約Agentで会話履歴を要約
  const generateOptions = {
    requestContext: summarizationContext,
    ...buildGenerateOptions(reviewCtx),
  };

  logger.debug(
    { requestContext: sanitizeForLog(summarizationContext.all) },
    'Calling summarizationAgent.generate',
  );

  let result;

  if (hasImages) {
    // 画像ありかつ通常のコンテキスト長エラー: マルチモーダルプロンプトで要約Agentを呼び出す
    const userPromptText = buildSummarizationUserPrompt(serializedText, wasTrimmed);
    const imageNotice =
      '\n\n## Image Data\nThe conversation contained image file reads. Image placeholders in the text above (e.g., [Image: path/to/file.png]) correspond to the actual image data provided as separate image content parts below. Use these images to understand what the review agent was analyzing.';

    const userMessage = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: userPromptText + imageNotice },
        ...imageData.map((img) => ({
          type: 'image' as const,
          image: Buffer.from(img.base64Data, 'base64'),
          mediaType: img.mediaType,
        })),
      ],
    };

    result = await withRateLimitRetry(
      () => summarizationAgent.generate(userMessage, generateOptions),
      rateLimitRetryConfig,
      { projectId },
    );
  } else if (imageData.length > 0 && imageCountExceeded) {
    // 画像数超過ケース: 画像データを除外し、ファイル名のみ使用
    const adjustedText = replaceImagePlaceholdersWithFilenames(serializedText, imageData);
    const imageExclusionNotice =
      '\n\n## Image Data Notice\nThe original conversation contained image file reads. However, the context length error was caused by too many images. Image data has been excluded from this summary request. Only filenames are shown. Summarize based on text information only.';
    const userPrompt =
      buildSummarizationUserPrompt(adjustedText, wasTrimmed) + imageExclusionNotice;

    result = await withRateLimitRetry(
      () => summarizationAgent.generate(userPrompt, generateOptions),
      rateLimitRetryConfig,
      { projectId },
    );
  } else {
    // 画像なしケース: 既存動作と同じ
    const userPrompt = buildSummarizationUserPrompt(serializedText, wasTrimmed);
    result = await withRateLimitRetry(
      () => summarizationAgent.generate(userPrompt, generateOptions),
      rateLimitRetryConfig,
      { projectId },
    );
  }

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
