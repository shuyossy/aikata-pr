import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { Memory } from '@mastra/memory';
import type { ReviewAgentRequestContext } from '../requestContext.js';
import { createModelFromContext } from '../requestContext.js';
import { storeReviewResultTool } from '../tools/storeReviewResult.js';
import { getReviewResultsTool } from '../tools/getReviewResults.js';

const reviewAgentTools = {
  storeReviewResult: storeReviewResultTool,
  getReviewResults: getReviewResultsTool,
};

/**
 * RequestContextからレビューエージェントのinstructionsを組み立てる
 */
function buildInstructions(requestContext: RequestContext<ReviewAgentRequestContext>): string {
  const ctx = requestContext.all;

  const ratingsText = ctx.ratings.map((r) => `- ${r.label}: ${r.definition}`).join('\n');
  const checkItemsText = ctx.checkItems
    .map((item) => `[ID: ${item.id}] ${item.content}`)
    .join('\n');

  let priorReviewText = '';
  if (ctx.priorReviewContext) {
    priorReviewText = `
## Prior Review Results

The following items were reviewed previously. Consider changes since then when re-reviewing.

Commits since prior review:
${ctx.priorReviewContext.commitMessages.map((m) => `- ${m}`).join('\n')}

Changes since prior review:
\`\`\`
${ctx.priorReviewContext.diffSincePrior}
\`\`\`

Previous results:
${ctx.priorReviewContext.results.map((r) => `- ${r.checkItemContent}: ${r.ratingLabel} - ${r.comment}`).join('\n')}
`;
  }

  return `You are an expert code reviewer specializing in merge request reviews. Your task is to review the provided merge request against a set of check items and provide ratings and comments for each.

## Merge Request Information

- Title: ${ctx.mrTitle}
- Description: ${ctx.mrDescription}
- Source Branch: ${ctx.mrSourceBranch}
- Target Branch: ${ctx.mrTargetBranch}

## Merge Request Diff

\`\`\`
${ctx.mrDiff}
\`\`\`
${priorReviewText}
## Check Items to Review

${checkItemsText}

## Rating Criteria

${ratingsText}

## Comment Format

Use the following format for your comments:
${ctx.commentFormat}

${ctx.additionalInstructions ? `## Additional Instructions\n\n${ctx.additionalInstructions}` : ''}

## Instructions

1. Review the merge request diff carefully against each check item.
2. For each check item, determine the appropriate rating based on the rating criteria.
3. Write a comment for each check item using the specified comment format.
4. Use the storeReviewResult tool to store EACH result. Use the check item ID (the number shown in [ID: N]) as the checkItemId parameter. You MUST call storeReviewResult for EVERY check item listed above.
5. After storing all results, use getReviewResults to verify that all check items have been reviewed.
6. Do NOT finish until ALL check items have been reviewed and stored.`;
}

/**
 * レビューエージェント用メモリ
 *
 * リトライ時に会話履歴を保持するためのメモリ設定。
 * lastMessages: 全メッセージをコンテキストに含めることで、
 * リトライ時に初回のツール呼び出し履歴等を参照可能にする。
 *
 * 前提: 各スレッドはexecuteReview()の実行単位で作成・削除されるため、
 * 会話は最大3回（初回 + リトライ2回）に限定される。
 */
const reviewAgentMemory = new Memory({
  options: {
    lastMessages: Number.MAX_SAFE_INTEGER,
  },
});

/**
 * レビューエージェント（シングルトン）
 *
 * MRのコードをチェック項目ごとにレビューし、評定とコメントを付けるエージェント。
 * モデルとinstructionsはRequestContextから動的に生成される。
 * メモリにより、リトライ時に会話履歴が保持される。
 */
export const reviewAgent = new Agent<
  'review-agent',
  typeof reviewAgentTools,
  undefined,
  ReviewAgentRequestContext
>({
  id: 'review-agent',
  name: 'Review Agent',
  memory: reviewAgentMemory,
  model: ({ requestContext }) => {
    const ctx = requestContext.all as ReviewAgentRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: ({ requestContext }) => {
    return buildInstructions(requestContext);
  },
  tools: reviewAgentTools,
});
