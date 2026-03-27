import { Agent } from '@mastra/core/agent';
import type { MastraLanguageModel } from '@mastra/core/agent';
import { storeReviewResultTool } from '../tools/storeReviewResult.js';
import { getReviewResultsTool } from '../tools/getReviewResults.js';

/**
 * レビューエージェント生成時の設定
 */
interface ReviewAgentConfig {
  model: MastraLanguageModel;
  checkItems: string[];
  ratings: Array<{ label: string; definition: string }>;
  commentFormat: string;
  additionalInstructions: string;
  mrContext: {
    title: string;
    description: string;
    sourceBranch: string;
    targetBranch: string;
    diff: string;
  };
  priorReviewContext: {
    results: Array<{ checkItemContent: string; ratingLabel: string; comment: string }>;
    commitMessages: string[];
    diffSincePrior: string;
  } | null;
}

/**
 * レビューエージェントのファクトリ関数
 *
 * MRのコードをチェック項目ごとにレビューし、評定とコメントを付けるエージェントを生成する。
 * モデルはユーザIDに基づいて動的に生成されるため、引数として受け取る。
 * チェック項目やMRコンテキストも実行時に決定されるため、全て引数で受け取る。
 */
export function createReviewAgent(config: ReviewAgentConfig): Agent {
  const ratingsText = config.ratings.map((r) => `- ${r.label}: ${r.definition}`).join('\n');

  const checkItemsText = config.checkItems.map((item, i) => `${i + 1}. ${item}`).join('\n');

  let priorReviewText = '';
  if (config.priorReviewContext) {
    priorReviewText = `
## Prior Review Results

The following items were reviewed previously. Consider changes since then when re-reviewing.

Commits since prior review:
${config.priorReviewContext.commitMessages.map((m) => `- ${m}`).join('\n')}

Changes since prior review:
\`\`\`
${config.priorReviewContext.diffSincePrior}
\`\`\`

Previous results:
${config.priorReviewContext.results.map((r) => `- ${r.checkItemContent}: ${r.ratingLabel} - ${r.comment}`).join('\n')}
`;
  }

  const instructions = `You are an expert code reviewer specializing in merge request reviews. Your task is to review the provided merge request against a set of check items and provide ratings and comments for each.

## Merge Request Information

- Title: ${config.mrContext.title}
- Description: ${config.mrContext.description}
- Source Branch: ${config.mrContext.sourceBranch}
- Target Branch: ${config.mrContext.targetBranch}

## Merge Request Diff

\`\`\`
${config.mrContext.diff}
\`\`\`
${priorReviewText}
## Check Items to Review

${checkItemsText}

## Rating Criteria

${ratingsText}

## Comment Format

Use the following format for your comments:
${config.commentFormat}

${config.additionalInstructions ? `## Additional Instructions\n\n${config.additionalInstructions}` : ''}

## Instructions

1. Review the merge request diff carefully against each check item.
2. For each check item, determine the appropriate rating based on the rating criteria.
3. Write a comment for each check item using the specified comment format.
4. Use the storeReviewResult tool to store EACH result. You MUST call storeReviewResult for EVERY check item listed above.
5. After storing all results, use getReviewResults to verify that all check items have been reviewed.
6. Do NOT finish until ALL check items have been reviewed and stored.`;

  return new Agent({
    id: 'review-agent',
    name: 'Review Agent',
    instructions,
    model: config.model,
    tools: {
      storeReviewResult: storeReviewResultTool,
      getReviewResults: getReviewResultsTool,
    },
  });
}
