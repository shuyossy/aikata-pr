import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { WorkflowAiConfig } from './requestContext.js';

/**
 * pipeline-reportのaiConfigからAIモデルを動的に作成するヘルパー
 *
 * reviewでは個別フィールド（aiApiKey/aiApiEndpointUrl/aiModelName）がトップレベルに
 * 積まれるのに対し、pipeline-reportではaiConfigとしてまとめて保持している。
 * 本ファクトリはpipeline-report配下のagent/step全てから参照される共通ヘルパ。
 */
export function createModelFromAiConfig(config: WorkflowAiConfig) {
  return createOpenAICompatible({
    name: 'openai',
    apiKey: config.apiKey,
    baseURL: config.endpointUrl,
  }).chatModel(config.modelName);
}
