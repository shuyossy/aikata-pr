import { Agent } from '@mastra/core/agent';
import type { ChecklistSplitAgentRequestContext } from '../requestContext.js';
import { createModelFromContext } from '../../shared/requestContext.js';

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

Given a list of check items with IDs in [ID: N] format, organize them into groups where each group contains items that are thematically similar or logically connected.

Check items may use a structured multi-column format where each column is presented as a header followed by its value enclosed between \`---\` delimiters. Use the content from all columns to determine thematic similarity.

Rules:
- Every input item must appear in exactly one group.
- Do not add or remove any items.
- Return item IDs (the numbers shown in [ID: N]) instead of text.
- Group by thematic similarity (e.g., code quality items together, security items together, performance items together, etc.).
- Try to keep groups roughly equal in size, close to the target group size.
- Return the result as a JSON object with a "groups" key containing an array of arrays of item IDs.`,
});
