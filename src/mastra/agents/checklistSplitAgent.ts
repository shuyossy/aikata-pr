import { Agent } from '@mastra/core/agent';
import type { ChecklistSplitAgentRequestContext } from '../requestContext.js';
import { createModelFromContext } from '../requestContext.js';

/**
 * チェックリスト分割エージェント（シングルトン）
 *
 * チェック項目群を類似性に基づいてグルーピングするエージェント。
 * モデルはRequestContextから動的に生成される。
 */
export const checklistSplitAgent = new Agent<
  'checklist-split-agent',
  Record<string, never>,
  undefined,
  ChecklistSplitAgentRequestContext
>({
  id: 'checklist-split-agent',
  name: 'Checklist Split Agent',
  model: ({ requestContext }) => {
    const ctx = requestContext.all as ChecklistSplitAgentRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: `You are a checklist grouping specialist. Your task is to group check items by similarity and relatedness so that related items can be reviewed together efficiently.

Given a list of check items, organize them into groups where each group contains items that are thematically similar or logically connected.

Rules:
- Every input item must appear in exactly one group.
- Do not add, remove, or modify any items.
- Return the exact original text of each item.
- Group by thematic similarity (e.g., code quality items together, security items together, performance items together, etc.).`,
});
