import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace';
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
 * RequestContextからレビューエージェントのsystemプロンプト（instructions）を組み立てる
 *
 * レビュー方針、ReAct推論フレームワーク、チェック項目、評定基準、ツールガイダンスを含む。
 * MR情報やdiff、過去チェック結果はuserプロンプト（buildUserPrompt）側に配置する。
 */
export function buildInstructions(
  requestContext: RequestContext<ReviewAgentRequestContext>,
): string {
  const ctx = requestContext.all;

  const ratingsText = ctx.ratings.map((r) => `- ${r.label}: ${r.definition}`).join('\n');
  const checkItemsText = ctx.checkItems
    .map((item) => `[ID: ${item.id}] ${item.content}`)
    .join('\n');

  const additionalInstructionsSection = ctx.additionalInstructions
    ? `## Additional Instructions\n\n${ctx.additionalInstructions}\n\n`
    : '';

  return `You are an expert MR (Merge Request) code review specialist. You will receive an MR diff and a set of check items. Your job is to evaluate each check item against the MR and provide a rating and comment.

## Reasoning Framework (ReAct)

For each check item, apply the Reason-Act-Observe cycle.

Repeat the following until you can confidently rate the check item:

**REASON**: Assess your current understanding.
- What does this check item require?
- What evidence do you already have from the diff or prior investigation?
- What is still unknown? Which tool would fill that gap, and why?

**ACT**: Execute your decision.
- If investigation is needed: call a workspace tool. State the reason before each call.
- If you have sufficient evidence: determine the rating, write a comment using the specified format, and call storeReviewResult to record the result.

**OBSERVE**: Evaluate the result of your action.
- If you used a workspace tool: did it answer your question? Does it raise new questions that affect your rating? If insufficient, return to REASON with updated understanding.
- If you stored a review result: move on to the next check item and start a new cycle.

## Efficiency Guidelines

- If prior review results are provided, focus your analysis on what changed since the prior review. Reuse prior conclusions for unchanged aspects.
- When multiple check items relate to the same code area, investigate once and apply findings across all relevant items.
- Most check items can be evaluated from the diff alone. Only investigate when you have genuine uncertainty that affects your rating.

## Check Items to Review

${checkItemsText}

## Rating Criteria

${ratingsText}

## Comment Format

Use the following format for your comments:
${ctx.commentFormat}

${additionalInstructionsSection}## Tool Reference

### Review Result Tools
- storeReviewResult: Store a review result for a single check item. Use the check item ID (the number shown in [ID: N]) as the checkItemId parameter. You MUST call this for EVERY check item listed above.
- getReviewResults: Retrieve stored results to verify completeness.

### Workspace Tools
You have access to workspace tools for investigating the project codebase:
- File reading: Examine source files beyond what the diff shows
- Directory listing: Understand project structure
- File search: Find code patterns across the codebase
- Sandbox commands: Run git commands, grep, or other CLI tools
The workspace root is the project repository root directory.

## Completion Requirements

1. You MUST review and store results for ALL check items listed above.
2. After storing all results, call getReviewResults to verify completeness.
3. Do NOT finish until ALL check items have been reviewed and stored.`;
}

/**
 * RequestContextからレビューエージェントのuserプロンプトを組み立てる
 *
 * MR情報、diff、過去チェック結果、結果ファイルパスを含む。
 * systemプロンプト（buildInstructions）と対になる。
 */
export function buildUserPrompt(
  requestContext: RequestContext<ReviewAgentRequestContext>,
  resultFilePath: string,
): string {
  const ctx = requestContext.all;

  let priorReviewSection = '';
  if (ctx.priorReviewContext) {
    const commitsText = ctx.priorReviewContext.commitMessages.map((m) => `- ${m}`).join('\n');
    const previousResultsText = ctx.priorReviewContext.results
      .map((r) => `- ${r.checkItemContent}: ${r.ratingLabel} - ${r.comment}`)
      .join('\n');

    priorReviewSection = `
## Prior Review Context

The following items were reviewed previously. Focus your analysis on changes since the prior review.

### Commits Since Prior Review
${commitsText}

### Changes Since Prior Review
\`\`\`
${ctx.priorReviewContext.diffSincePrior}
\`\`\`

### Previous Results
${previousResultsText}

`;
  }

  const folderTreeSection = ctx.folderTree
    ? `
## Project Folder Tree

The following is the folder/file tree of the project being reviewed:

\`\`\`
${ctx.folderTree}
\`\`\`
`
    : '';

  return `## Merge Request Information

- Title: ${ctx.mrTitle}
- Description: ${ctx.mrDescription}
- Source Branch: ${ctx.mrSourceBranch}
- Target Branch: ${ctx.mrTargetBranch}
${folderTreeSection}
## Merge Request Diff

\`\`\`
${ctx.mrDiff}
\`\`\`
${priorReviewSection}
---

Review all ${ctx.checkItems.length} check items following the reasoning framework in your instructions. Store each result using the storeReviewResult tool. The result file path is: ${resultFilePath}`;
}

/**
 * レビューエージェント用メモリ
 *
 * リトライ時に会話履歴を保持するためのメモリ設定。
 * lastMessages: コンテキストに含めるメッセージ数の上限。
 *
 * 1000に設定する理由:
 * - ワークスペースツールによる大規模コードベースの探索時には多数のツール呼び出しが発生し得る
 * - 1000は実用上十分な上限でありつつ、無制限によるコンテキストウィンドウ溢れを防止する
 * - 各スレッドはexecuteReview()の実行単位で作成・削除される（初回 + リトライ最大2回）
 */
const reviewAgentMemory = new Memory({
  options: {
    lastMessages: 1000,
  },
});

/**
 * RequestContextからWorkspaceを動的に生成するファクトリ
 *
 * プロジェクトディレクトリをbasePath/workingDirectoryとして設定し、
 * ユーザ指定のskillsパスを登録する。
 * filesystemはreadOnlyにすることで、レビュー時の意図しない書き込みを防ぐ。
 */
export function createWorkspaceFromContext(ctx: ReviewAgentRequestContext): Workspace {
  return new Workspace({
    filesystem: new LocalFilesystem({
      basePath: ctx.projectDir,
      readOnly: true,
    }),
    sandbox: new LocalSandbox({
      workingDirectory: ctx.projectDir,
    }),
    skills: ctx.skillsPaths.length > 0 ? ctx.skillsPaths : undefined,
  });
}

/**
 * レビューエージェント（シングルトン）
 *
 * MRのコードをチェック項目ごとにレビューし、評定とコメントを付けるエージェント。
 * モデル、instructions、workspaceはRequestContextから動的に生成される。
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
  workspace: ({ requestContext }) => {
    const ctx = requestContext.all as ReviewAgentRequestContext;
    return createWorkspaceFromContext(ctx);
  },
});
