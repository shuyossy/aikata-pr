import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import type { ReviewAgentRequestContext } from '../requestContext.js';
import { createModelFromContext } from '../../shared/requestContext.js';
import { storeReviewResultTool } from '../tools/storeReviewResult.js';
import { getReviewResultsTool } from '../tools/getReviewResults.js';
import { readImageTool } from '../tools/readImage.js';
import { getDiffDetailTool } from '../tools/getDiffDetail.js';
import { storeSuggestTool } from '../tools/storeSuggest.js';
import { getSuggestsTool } from '../tools/getSuggests.js';
import { containsImageFiles } from '../../../lib/imageFormat.js';
import { buildUserPromptTemplate } from '../../../application/shared/prompt/index.js';
import { WORKSPACE_TOOLS_CONFIG } from '../../shared/workspaceToolsConfig.js';

// 後方互換のため shared から re-export
export { buildPrepareStepForImageInjection } from '../../shared/prepareStepForImageInjection.js';

// レビューエージェントのツールセット型（readImage, getDiffDetail, suggest系は条件付き登録）
type ReviewAgentToolSet = {
  storeReviewResult: typeof storeReviewResultTool;
  getReviewResults: typeof getReviewResultsTool;
  readImage?: typeof readImageTool;
  getDiffDetail?: typeof getDiffDetailTool;
  storeSuggest?: typeof storeSuggestTool;
  getSuggests?: typeof getSuggestsTool;
};

// 基本ツール（常に登録）
const baseReviewAgentTools: ReviewAgentToolSet = {
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
    .map((item) => `[ID: ${item.id}]\n${item.content}`)
    .join('\n\n');

  const additionalInstructionsSection = ctx.additionalInstructions
    ? `## User-Specified Review Instructions (HIGHEST PRIORITY)\n\nThe following instructions were provided by the user as review requirements. You MUST follow these instructions with the highest priority.\n\n${ctx.additionalInstructions}\n\n`
    : '';

  const suggestEnabled = ctx.suggestEnabledRatingLabels.length > 0;
  const suggestLabelsText = ctx.suggestEnabledRatingLabels.join(', ');

  const suggestRoleSuffix = suggestEnabled
    ? ` Additionally, for check items rated [${suggestLabelsText}], you MUST generate concrete code suggestions using the storeSuggest tool.`
    : '';

  return `You are an expert MR (Merge Request) code review specialist. You will receive an MR diff, the project folder tree, and a set of check items. Your job is to evaluate each check item against the MR and provide a rating and comment.${suggestRoleSuffix}

Always reason and think in English. When writing review comments, you MUST write them in ${ctx.commentLanguage}.

## Reasoning Framework (ReAct)

For each check item, apply the Reason-Act-Observe cycle.

Repeat the following until you can confidently rate the check item:

**REASON**: Assess your current understanding.
- What does this check item require?
- What evidence do you already have from the diff or prior investigation?
- What is still unknown? Which tool would fill that gap, and why?

**ACT**: Execute your decision.
- If investigation is needed: call a workspace tool. State the reason before each call.
- If you have sufficient evidence: first write a comment using the specified format, then decide the rating that is consistent with what you wrote in the comment, and call storeReviewResult to record the result. Always write the comment before choosing the rating so the rating follows from the comment, not the other way around.

**OBSERVE**: Evaluate the result of your action.
- If you used a workspace tool: did it answer your question? Does it raise new questions that affect your rating? If insufficient, return to REASON with updated understanding.
- If you stored a review result: move on to the next check item and start a new cycle.

Before using any tool(s), explain to users the reasoning behind why you are using that tool(s).

## Efficiency Guidelines

- If prior review results are provided, still review the entire MR comprehensively based on the full diff. Use prior results only as reference context — they may inform your analysis, but do not skip or shortcut any check item based on prior conclusions.
- When multiple check items relate to the same code area, investigate once and apply findings across all relevant items.
- Most check items can be evaluated from the diff alone. Only investigate when you have genuine uncertainty that affects your rating.

## Check Items to Review

Each check item is identified by a prefix [ID: N]. When calling storeReviewResult, use this ID number.

Check items may use a structured multi-column format. In this format, each column is presented as:

<header>:
---
<value>
---

Multiple columns within a single check item are separated by blank lines. Treat all columns together as one cohesive review criterion — the header provides context (e.g., category, description) and the value provides the specific content for that column.

Some check items may instead appear as plain text without the structured format. Review these in the same way.

${checkItemsText}

## Rating Criteria

${ratingsText}

## Comment Format

Use the following format for your comments:
${ctx.commentFormat}

You must strictly follow the above format. Do not add any extra sections or headings beyond what is specified.

${additionalInstructionsSection}## Tool Reference

### Review Result Tools
- storeReviewResult: Store a review result for a single check item. Parameters: checkItemId (the number shown in [ID: N]), comment (MUST be written in ${ctx.commentLanguage}; write this first), ratingLabel (one of the rating labels above; choose this after the comment so it is consistent with what you wrote). You MUST call this for EVERY check item listed above.
- getReviewResults: Retrieve stored results to verify completeness. No arguments needed.
${
  containsImageFiles(ctx.folderTree)
    ? `
### Image Reading Tool
- readImage: Read an image file from the project directory and view its contents. You MUST use this tool whenever you need to view or analyze an image file referenced in the diff or project. Supported formats: PNG, JPEG, GIF, WebP.
  - Always use this tool instead of trying to infer image contents from filenames or context.
  - Pass the file path relative to the project root directory.
`
    : ''
}
${
  ctx.folderTreeRemovedByCompression
    ? `### Folder Tree Notice
File entries have been removed from the project folder tree to conserve context space. Only directory structure is shown. Use the mastra_workspace_list_files tool to view files in specific directories.

`
    : ''
}${
    ctx.diffCompressed
      ? `### Diff Compression Notice
Some file diffs have been compressed to fit within context limits. Compressed sections are marked with "[aikata: N lines omitted from middle]". Use the getDiffDetail tool to retrieve the omitted portion:
- getDiffDetail(filePath): Get the omitted middle portion (output is token-limited; may be truncated for very large diffs)
- getDiffDetail(filePath, keywords, contextLines): Search for specific patterns within the omitted portion
- getDiffDetail(filePath, { startLine, maxLines }): Navigate to a specific line range within the omitted portion

If the output shows "[output truncated: ...]", use the reported line counts and startLine/maxLines to read remaining content, or use keywords to narrow results.

`
      : ''
  }${
    suggestEnabled
      ? `### Suggestion Tools
- storeSuggest: Store a code suggestion. Parameters: checkItemId, filePath, originalCode (code from the new side of the diff — each line must be complete, not truncated), suggestedCode (replacement), comment (explanation in ${ctx.commentLanguage})
- getSuggests: Retrieve all suggestions stored in this session to check for duplicates and verify completeness

`
      : ''
  }### Workspace Tools
You have access to workspace tools for investigating the project codebase. The project folder tree provided in the user message is the map of this repository — use it to decide which files or directories to open with these tools:
- File reading: Examine source files beyond what the diff shows
- Directory listing: Understand project structure
- File search: Find code patterns across the codebase
- Sandbox commands: Run git commands, grep, or other CLI tools
The workspace root is the project repository root directory.
${
  suggestEnabled
    ? `
## Code Suggestion Guidelines

For check items that receive a rating of [${suggestLabelsText}], you MUST generate concrete code suggestions using the storeSuggest tool.

### How to create suggestions
1. Re-read your review comment for the check item (from getReviewResults) and identify the specific issue described
2. Identify the specific code in the diff that relates to that issue
3. Copy the exact original code (as it appears in the new side of the diff) into originalCode — include enough surrounding lines to uniquely identify the location
4. Write the improved code in suggestedCode that directly resolves the issue described in your review comment
5. Provide a clear explanation in comment that references the same issue noted in your review

### Important rules
- You may create multiple suggestions per check item
- Do NOT duplicate suggestions within this session (check with getSuggests)
- Each line in originalCode must be copied in its entirety — do not truncate or omit parts of a line, even if the line is very long. Include the complete line from beginning to end.
- Include sufficient context lines in originalCode to avoid ambiguity
- Suggestions can only target code that appears within the diff hunks (changed lines and their surrounding context lines). Code outside the diff cannot be targeted. A single suggestion cannot span across hunk boundaries.
- Each suggestion MUST address the specific issue described in your review comment for that check item. Do not suggest fixes for different issues than what you identified during review.

### Error recovery for storeSuggest
- If storeSuggest fails, carefully read the error message and retry with corrected input.
- If the error mentions multiple matches, include more surrounding lines in originalCode.
- Always retry at least once before giving up on a suggestion.
- When retrying, try a shorter or different code snippet if the same one keeps failing.

`
    : ''
}## Completion Requirements

1. You MUST review and store results for ALL check items listed above.
2. After storing all results, call getReviewResults to verify completeness.
3. Do NOT finish until ALL check items have been reviewed and stored.${
    suggestEnabled
      ? `
4. After storing all review results, re-read the results from getReviewResults. For each item rated [${suggestLabelsText}], generate suggestions that directly address the issue described in your review comment for that item.
5. Call getSuggests to verify all suggestions are stored.`
      : ''
  }`;
}

/**
 * RequestContextからレビューエージェントのuserプロンプトを組み立てる
 *
 * MR情報、diff、過去チェック結果を含む。
 * systemプロンプト（buildInstructions）と対になる。
 */
export function buildUserPrompt(requestContext: RequestContext<ReviewAgentRequestContext>): string {
  const ctx = requestContext.all;
  return buildUserPromptTemplate({
    mrTitle: ctx.mrTitle,
    mrDescription: ctx.mrDescription,
    mrSourceBranch: ctx.mrSourceBranch,
    mrTargetBranch: ctx.mrTargetBranch,
    mrDiff: ctx.mrDiff,
    folderTree: ctx.folderTree,
    priorReviewContext: ctx.priorReviewContext,
    checkItemCount: ctx.checkItems.length,
  });
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
      // Mastraデフォルトの "File access is restricted to this directory." は
      // エージェントにフォルダツリー探索不可と誤解させる恐れがあるため、
      // コードベースの所在と相対パス利用を明示したinstructionsに置き換える
      instructions: `The project codebase is located at "${ctx.projectDir}". The folder tree provided in the user message reflects the contents of this directory. Use relative paths (e.g. "src/index.ts") to access files.`,
    }),
    sandbox: new LocalSandbox({
      workingDirectory: ctx.projectDir,
      // Mastraデフォルトと同等だが、明示的に指定することで
      // 将来のMastraバージョン変更による意図しない変更を防ぐ
      instructions: `Local command execution. Working directory: "${ctx.projectDir}".`,
    }),
    skills: ctx.skillsPaths.length > 0 ? ctx.skillsPaths : undefined,
    tools: WORKSPACE_TOOLS_CONFIG,
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
  ReviewAgentToolSet,
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
  tools: ({ requestContext }) => {
    const ctx = requestContext.all as ReviewAgentRequestContext;
    const suggestEnabled = ctx.suggestEnabledRatingLabels.length > 0;

    // 基本ツールに条件に応じてツールを追加する
    let toolSet: ReviewAgentToolSet = { ...baseReviewAgentTools };

    if (containsImageFiles(ctx.folderTree)) {
      toolSet = { ...toolSet, readImage: readImageTool };
    }
    if (ctx.diffCompressed) {
      toolSet = { ...toolSet, getDiffDetail: getDiffDetailTool };
    }
    if (suggestEnabled) {
      toolSet = { ...toolSet, storeSuggest: storeSuggestTool, getSuggests: getSuggestsTool };
    }

    return toolSet;
  },
  workspace: ({ requestContext }) => {
    const ctx = requestContext?.all as ReviewAgentRequestContext | undefined;
    if (!ctx?.projectDir) {
      return undefined;
    }
    return createWorkspaceFromContext(ctx);
  },
});
