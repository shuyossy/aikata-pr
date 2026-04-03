/**
 * レビューエージェントのuserプロンプトテンプレート
 *
 * reviewAgent.buildUserPromptとExecuteReviewService.buildEstimatedUserPromptの
 * 両方から利用される共通ロジック。
 * トークン数推定の正確性を保証するため、プロンプト構築ロジックを一元化する。
 */

export interface PriorReviewInfo {
  results: Array<{ checkItemContent: string; ratingLabel: string; comment: string }>;
  commitMessages: string[];
  diffSincePrior: string;
}

export interface UserPromptParams {
  mrTitle: string;
  mrDescription: string;
  mrSourceBranch: string;
  mrTargetBranch: string;
  mrDiff: string;
  folderTree: string;
  priorReviewContext: PriorReviewInfo | null;
  checkItemCount: number;
}

export function buildUserPromptTemplate(params: UserPromptParams): string {
  let priorReviewSection = '';
  if (params.priorReviewContext) {
    const commitsText = params.priorReviewContext.commitMessages.map((m) => `- ${m}`).join('\n');
    const previousResultsText = params.priorReviewContext.results
      .map((r) => `- ${r.checkItemContent}: ${r.ratingLabel} - ${r.comment}`)
      .join('\n');

    priorReviewSection = `
## Prior Review Context (Reference Only)

A prior review was conducted for this MR. The information below is provided as supplementary reference only. You MUST still review the entire MR comprehensively based on the full Merge Request Diff above. Do not skip or shortcut any check item based on prior conclusions.

### Commits Since Prior Review
${commitsText}

### Diff Since Prior Review
\`\`\`
${params.priorReviewContext.diffSincePrior}
\`\`\`

### Previous Review Results
${previousResultsText}

`;
  }

  const folderTreeSection = params.folderTree
    ? `
## Project Folder Tree

The following is the folder/file tree of the project being reviewed:

\`\`\`
${params.folderTree}
\`\`\`
`
    : '';

  return `## Merge Request Information

- Title: ${params.mrTitle}
- Description: ${params.mrDescription}
- Source Branch: ${params.mrSourceBranch}
- Target Branch: ${params.mrTargetBranch}
${folderTreeSection}
## Merge Request Diff

\`\`\`
${params.mrDiff}
\`\`\`
${priorReviewSection}
---

Review all ${params.checkItemCount} check items following the reasoning framework in your instructions. Store each result using the storeReviewResult tool.`;
}
