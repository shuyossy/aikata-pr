import { Agent } from '@mastra/core/agent';
import type { MastraLanguageModel } from '@mastra/core/agent';

/**
 * チェックリスト分割エージェントのファクトリ関数
 *
 * チェック項目群を類似性に基づいてグルーピングするエージェントを生成する。
 * モデルはユーザIDに基づいて動的に生成されるため、引数として受け取る。
 */
export function createChecklistSplitAgent(model: MastraLanguageModel): Agent {
  return new Agent({
    id: 'checklist-split-agent',
    name: 'Checklist Split Agent',
    instructions: `You are a checklist grouping specialist. Your task is to group check items by similarity and relatedness so that related items can be reviewed together efficiently.

Given a list of check items, organize them into groups where each group contains items that are thematically similar or logically connected.

Rules:
- Every input item must appear in exactly one group.
- Do not add, remove, or modify any items.
- Return the exact original text of each item.
- Group by thematic similarity (e.g., code quality items together, security items together, performance items together, etc.).`,
    model,
  });
}
