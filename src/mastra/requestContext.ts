import type { MastraLanguageModel } from '@mastra/core/agent';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * ワークフローレベルのRequestContext型（モデル設定のみ）
 */
export interface WorkflowRequestContext {
  userId: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
}

/**
 * ChecklistSplitAgent用RequestContext型（モデル設定のみ）
 */
export type ChecklistSplitAgentRequestContext = WorkflowRequestContext;

/**
 * ReviewAgent用RequestContext型（モデル設定 + レビュー全データ）
 */
export interface ReviewAgentRequestContext extends WorkflowRequestContext {
  checkItems: string[];
  ratings: Array<{ label: string; definition: string }>;
  commentFormat: string;
  additionalInstructions: string;
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
