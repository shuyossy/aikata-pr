import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent, MastraDBMessage, MastraMessagePart } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type {
  PipelineAnalysisAgentRequestContext,
  PipelineReportSummarizationRequestContext,
} from '../../requestContext.js';
import { buildPipelineReportSummarizationUserPrompt } from '../../agents/pipelineReportSummarizationAgent.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../../lib/rateLimitRetry.js';
import { getLogger } from '../../../../lib/logger.js';
import { isImageCountExceededError } from '../../../../lib/aiApiError.js';
import { IMAGE_MESSAGE_PREFIX } from '../../../shared/readImageCommon.js';

/**
 * シリアライズ後の文字数上限
 * review の contextLengthRecovery と同値。超過時はメッセージ数ベースの中間カットを実行する。
 */
export const MAX_SERIALIZED_CHARS = 80000;

/**
 * コンテキスト長リカバリーの設定
 */
export interface PipelineReportContextLengthRecoveryConfig {
  analysisAgent: Agent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summarizationAgent: Agent<string, Record<string, any>, any, any>;
  threadId: string;
  resourceId: string;
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>;
  rateLimitRetryConfig: RateLimitRetryConfig;
  originalError?: unknown;
}

/**
 * コンテキスト長リカバリーの結果
 */
export interface PipelineReportContextLengthRecoveryResult {
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
 * メッセージ数ベースの中間カット（先頭10%＋末尾50%）を行う。
 * prepareStep で注入された画像付きメッセージからは画像データを抽出し、
 * プレースホルダー（`[Image: <filePath>]`）に置換する。
 */
export function serializeMessages(
  messages: MastraDBMessage[],
  maxChars: number = MAX_SERIALIZED_CHARS,
): { text: string; wasTrimmed: boolean; imageData: ExtractedImageData[] } {
  const imageData: ExtractedImageData[] = [];

  if (messages.length === 0) {
    return { text: '', wasTrimmed: false, imageData };
  }

  const serialized = messages.map((msg) => serializeSingleMessage(msg, imageData));
  const fullText = serialized.join('\n\n');

  if (fullText.length <= maxChars) {
    return { text: fullText, wasTrimmed: false, imageData };
  }

  const totalCount = messages.length;
  const headCount = Math.max(1, Math.ceil(totalCount * 0.1));
  const tailCount = Math.max(1, Math.ceil(totalCount * 0.5));

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
 * 画像/ファイルパートから base64 データを抽出するヘルパー
 */
function extractBase64FromPart(part: MastraMessagePart): string {
  const raw = part as Record<string, unknown>;
  if (typeof raw.image === 'string') return raw.image;
  if (raw.image instanceof Buffer) return raw.image.toString('base64');
  if (typeof raw.data === 'string') return raw.data;
  return '';
}

/**
 * 画像/ファイルパートから mediaType を抽出するヘルパー
 */
function extractMediaType(part: MastraMessagePart): string {
  const raw = part as Record<string, unknown>;
  if (typeof raw.mimeType === 'string') return raw.mimeType;
  if (typeof raw.mediaType === 'string') return raw.mediaType;
  return 'image/png';
}

/**
 * prepareStep で注入された画像付きuserメッセージから画像データを抽出する
 * - textパートから `"1. path/to/file.png"` 形式のファイルパスを解析
 * - file パート（画像データ）と 1:1 で対応付ける
 */
function extractImagesFromUserMessage(
  parts: MastraMessagePart[],
  imageData: ExtractedImageData[],
): boolean {
  const textPart = parts.find((p) => p.type === 'text' && typeof p.text === 'string');
  if (!textPart || textPart.type !== 'text' || !textPart.text?.includes(IMAGE_MESSAGE_PREFIX)) {
    return false;
  }

  // "1. path/to/file.png" 形式のファイルパスをマッチ
  const filePaths: string[] = [];
  const lines = textPart.text.split('\n');
  for (const line of lines) {
    const match = /^\d+\.\s+(.+)$/.exec(line);
    if (match) {
      filePaths.push(match[1]);
    }
  }

  const imageParts = parts.filter((p) => p.type === 'file');

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
 */
function serializeSingleMessage(message: MastraDBMessage, imageData: ExtractedImageData[]): string {
  const parts: string[] = [];
  parts.push(`[${message.role}]`);

  if (message.content.parts.length > 0) {
    if (message.role === 'user' && extractImagesFromUserMessage(message.content.parts, imageData)) {
      for (const part of message.content.parts) {
        if (part.type === 'text' && part.text) {
          parts.push(part.text);
        }
      }
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
        const resultStr =
          inv.state === 'result' && inv.result
            ? String(typeof inv.result === 'object' ? JSON.stringify(inv.result) : inv.result)
            : '';
        parts.push(`[Tool: ${inv.toolName}]`);
        if (argsStr) parts.push(`  Args: ${argsStr}`);
        if (resultStr) parts.push(`  Result: ${resultStr}`);
      }
      // text / tool-invocation 以外のパート（reasoning, source, file 等）は無視
    }
  } else if (message.content.content) {
    parts.push(String(message.content.content));
  }

  return parts.join('\n');
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
 * 1. メモリからスレッドメッセージを全件取得
 * 2. メッセージをシリアライズ（画像データを抽出）
 * 3. 要約Agent用のRequestContextを構築
 * 4. 要約Agentで会話履歴を要約（画像対応）
 * 5. 旧スレッドを削除
 * 6. 新しいthreadIdと要約テキストを返す
 */
export async function recoverFromContextLength(
  config: PipelineReportContextLengthRecoveryConfig,
): Promise<PipelineReportContextLengthRecoveryResult> {
  const logger = getLogger();
  const {
    analysisAgent,
    summarizationAgent,
    threadId,
    requestContext,
    rateLimitRetryConfig,
    originalError,
  } = config;

  const ctx = requestContext.all;
  const projectIdStr = String(ctx.projectId);

  logger.info({ threadId }, 'Starting pipeline-report context length recovery');

  // 1. メモリからスレッドメッセージを取得（perPage=false で全件）
  const memory = await analysisAgent.getMemory();
  let messages: MastraDBMessage[] = [];
  if (memory) {
    const recalled = await memory.recall({
      threadId,
      perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    messages = recalled.messages;
  }

  // 2. メッセージをシリアライズ（画像データを抽出）
  const { text: serializedText, wasTrimmed, imageData } = serializeMessages(messages);

  const imageCountExceeded = originalError ? isImageCountExceededError(originalError) : false;
  const hasImages = imageData.length > 0 && !imageCountExceeded;

  // 3. 要約Agent用のRequestContextを構築
  const summarizationContext = new RequestContext<PipelineReportSummarizationRequestContext>([
    ['userId', ctx.userId],
    ['aiConfig', ctx.aiConfig],
    ['targetJobs', ctx.targetJobs],
  ]);

  const generateOptions: Record<string, unknown> = {
    requestContext: summarizationContext,
  };

  if (ctx.aiConfig.reasoningEffort) {
    generateOptions.modelSettings = { temperature: 1 };
    generateOptions.providerOptions = {
      openai: { reasoningEffort: ctx.aiConfig.reasoningEffort },
    };
  }

  // 4. 要約Agent呼び出し
  let result: { text: string };

  if (hasImages) {
    const userPromptText = buildPipelineReportSummarizationUserPrompt(serializedText, wasTrimmed);
    const imageNotice =
      '\n\n## Image Data\nThe conversation contained image file reads. Image placeholders in the text above (e.g., [Image: path/to/file.png]) correspond to the actual image data provided as separate image content parts below. Use these images to understand what the pipeline analysis agent was looking at.';

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
      { projectId: projectIdStr },
    );
  } else if (imageData.length > 0 && imageCountExceeded) {
    const adjustedText = replaceImagePlaceholdersWithFilenames(serializedText, imageData);
    const exclusionNotice =
      '\n\n## Image Data Notice\nThe original conversation contained image file reads. However, the context length error was caused by too many images. Image data has been excluded from this summary request. Only filenames are shown. Summarize based on text information only.';
    const userPrompt =
      buildPipelineReportSummarizationUserPrompt(adjustedText, wasTrimmed) + exclusionNotice;

    result = await withRateLimitRetry(
      () => summarizationAgent.generate(userPrompt, generateOptions),
      rateLimitRetryConfig,
      { projectId: projectIdStr },
    );
  } else {
    const userPrompt = buildPipelineReportSummarizationUserPrompt(serializedText, wasTrimmed);
    result = await withRateLimitRetry(
      () => summarizationAgent.generate(userPrompt, generateOptions),
      rateLimitRetryConfig,
      { projectId: projectIdStr },
    );
  }

  const summary = typeof result.text === 'string' ? result.text : String(result.text);

  // 5. 旧スレッドを削除
  if (memory) {
    try {
      await memory.deleteThread(threadId);
    } catch {
      logger.warn({ threadId }, 'Failed to delete old thread during context length recovery');
    }
  }

  // 6. 新しい threadId と要約を返す
  const newThreadId = randomUUID();
  logger.info(
    { oldThreadId: threadId, newThreadId },
    'Pipeline-report context length recovery completed',
  );

  return { newThreadId, summary };
}
