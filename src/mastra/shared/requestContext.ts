import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * ワークフローレベルのRequestContext型（モデル設定 + プロジェクト情報）
 */
export interface WorkflowRequestContext {
  userId: string;
  projectId: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  projectDir: string;
  openaiReasoningEffort: string | undefined;
}

/**
 * RequestContextからAIモデルを動的に作成するヘルパー関数
 */
export function createModelFromContext(ctx: WorkflowRequestContext) {
  return createOpenAICompatible({
    name: 'openai',
    apiKey: ctx.aiApiKey,
    baseURL: ctx.aiApiEndpointUrl,
  }).chatModel(ctx.aiModelName);
}

/**
 * requestContext.allをログ出力用にサニタイズする
 * - aiApiKey: マスク
 * - mrDiff: 文字数のみ表示（長大なため）
 * - omittedFileDiffs: エントリ数のみ表示（長大なため）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitizeForLog(ctx: Record<string, any>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...ctx };
  if ('aiApiKey' in sanitized) {
    sanitized.aiApiKey = '***';
  }
  // if ('mrDiff' in sanitized && typeof sanitized.mrDiff === 'string') {
  //   sanitized.mrDiff = `[${(sanitized.mrDiff as string).length} chars]`;
  // }
  // if ('omittedFileDiffs' in sanitized && sanitized.omittedFileDiffs instanceof Map) {
  //   sanitized.omittedFileDiffs = `[Map with ${(sanitized.omittedFileDiffs as Map<string, string>).size} entries]`;
  // }
  return sanitized;
}

/**
 * OPENAI_REASONING_EFFORTが設定されている場合のgenerate()オプションを構築する
 * 未設定の場合は空オブジェクトを返す（spread時に影響なし）
 */
export function buildGenerateOptions(ctx: WorkflowRequestContext): {
  modelSettings?: { temperature: number };
  providerOptions?: { openai: { reasoningEffort: string } };
} {
  if (!ctx.openaiReasoningEffort) return {};
  return {
    modelSettings: { temperature: 1 },
    providerOptions: {
      openai: { reasoningEffort: ctx.openaiReasoningEffort },
    },
  };
}
