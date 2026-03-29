import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { IndexedCheckItem } from './indexedCheckItem.js';

/**
 * ワークフローレベルのRequestContext型（モデル設定 + プロジェクト情報）
 */
export interface WorkflowRequestContext {
  userId: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  projectDir: string;
  openaiReasoningEffort: string | undefined;
}

/**
 * ChecklistSplitAgent用RequestContext型（モデル設定のみ）
 */
export type ChecklistSplitAgentRequestContext = WorkflowRequestContext;

/**
 * ReviewAgent用RequestContext型（モデル設定 + レビュー全データ）
 */

export interface ReviewAgentRequestContext extends WorkflowRequestContext {
  checkItems: IndexedCheckItem[];
  ratings: Array<{ label: string; definition: string }>;
  commentFormat: string;
  additionalInstructions: string;
  resultFilePath: string;
  commentLanguage: string;
  mrTitle: string;
  mrDescription: string;
  mrSourceBranch: string;
  mrTargetBranch: string;
  mrDiff: string;
  priorReviewContext: {
    results: Array<{ checkItemContent: string; ratingLabel: string; comment: string }>;
    commitMessages: string[];
    diffSincePrior: string;
  } | null;
  skillsPaths: string[];
  folderTree: string;
}

/**
 * SummarizationAgent用RequestContext型（モデル設定 + 要約に必要なコンテキスト）
 */
export interface SummarizationAgentRequestContext extends WorkflowRequestContext {
  checkItems: IndexedCheckItem[];
  mrTitle: string;
  mrSourceBranch: string;
  mrTargetBranch: string;
  alreadyStoredSummary: string;
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
