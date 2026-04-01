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
## Prior Review Context

The following items were reviewed previously. Focus your analysis on changes since the prior review.

### Commits Since Prior Review
${commitsText}

### Changes Since Prior Review
\`\`\`
${params.priorReviewContext.diffSincePrior}
\`\`\`

### Previous Results
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
