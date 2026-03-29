import type { MastraLanguageModel } from '@mastra/core/agent';
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
 *
 * createOpenAICompatibleが返すLanguageModelV3をMastraLanguageModelとしてキャストする。
 * AgentコンストラクタはMastraModelConfig（LanguageModelV3を含む）を受け入れるが、
 * ファクトリ関数のシグネチャがMastraLanguageModelを要求するためキャストが必要。
 */
export function createModelFromContext(ctx: WorkflowRequestContext): MastraLanguageModel {
  return createOpenAICompatible({
    name: ctx.userId,
    apiKey: ctx.aiApiKey,
    baseURL: ctx.aiApiEndpointUrl,
  }).chatModel(ctx.aiModelName) as unknown as MastraLanguageModel;
}
