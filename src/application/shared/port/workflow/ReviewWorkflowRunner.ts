/**
 * ワークフロー実行のパラメータ
 */
export interface ReviewWorkflowParams {
  checkItemContents: string[];
  concurrentReviewCount: number | null;
  ratings: Array<{ label: string; definition: string }>;
  commentFormat: string;
  additionalInstructions: string;
  mrTitle: string;
  mrDescription: string;
  mrSourceBranch: string;
  mrTargetBranch: string;
  mrDiff: string;
  mrCommitHash: string;
  priorReviewResults: Array<{
    checkItemContent: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
  }> | null;
  priorCommitMessages: string[] | null;
  priorDiffSincePrior: string | null;
  userId: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  projectDir: string;
  skillsPaths: string[];
  resultFilePath: string;
  folderTree: string;
  commentLanguage: string;
  openaiReasoningEffort: string | undefined;
  omittedFileDiffs: Record<string, string> | null;
  allDiffFilePaths: string[] | null;
  diffCompressed: boolean;
  folderTreeRemovedByCompression: boolean;
}

/**
 * ワークフロー実行の結果
 */
export interface ReviewWorkflowResult {
  results: Array<{
    checkItemContent: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError: boolean;
    errorMessage?: string;
  }>;
}

/**
 * ワークフロー実行のインターフェース（Mastra Workflowの実行をラップ）
 */
export interface ReviewWorkflowRunner {
  run(params: ReviewWorkflowParams): Promise<ReviewWorkflowResult>;
}
