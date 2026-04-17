import type { WorkflowRequestContext } from '../shared/requestContext.js';
import type { IndexedCheckItem } from './indexedCheckItem.js';
import type { PendingImageData } from './tools/readImage.js';
import type { SuggestionLineResolver } from '../../application/shared/port/suggestion/index.js';

/**
 * ChecklistSplitAgent用RequestContext型（モデル設定のみ）
 */
export type ChecklistSplitAgentRequestContext = WorkflowRequestContext;

/**
 * ReviewAgent用RequestContext型（モデル設定 + レビュー全データ）
 */
export interface ReviewAgentRequestContext extends WorkflowRequestContext {
  checkItems: IndexedCheckItem[];
  ratings: Array<{ label: string; definition: string }>;
  commentFormat: string;
  additionalInstructions: string;
  resultFilePath: string;
  commentLanguage: string;
  mrTitle: string;
  mrDescription: string;
  mrSourceBranch: string;
  mrTargetBranch: string;
  mrDiff: string;
  priorReviewContext: {
    results: Array<{ checkItemContent: string; ratingLabel: string; comment: string }>;
    commitMessages: string[];
    diffSincePrior: string;
  } | null;
  skillsPaths: string[];
  folderTree: string;
  pendingImages: PendingImageData[];
  /** 各ファイルの省略された中間部分のみ（getDiffDetailツール用） */
  omittedFileDiffs: Map<string, string> | null;
  /** diff内の全ファイルパス一覧（圧縮有無判定用） */
  allDiffFilePaths: Set<string> | null;
  /** diff圧縮が実行されたかどうか（ツール登録判定用） */
  diffCompressed: boolean;
  /** フォルダツリーのファイルが除去されたかどうか（systemプロンプトへの指示追加用） */
  folderTreeRemovedByCompression: boolean;
  /** suggest有効対象の評定ラベル配列（空配列の場合はsuggest無効） */
  suggestEnabledRatingLabels: string[];
  /** suggest結果ファイルパス */
  suggestResultFilePath: string;
  /** MRの完全なdiff（suggest行番号解決用） */
  fullMrDiff: string;
  /** 以前のレビューで有効なsuggest一覧 */
  activeSuggests: Array<{
    checkItemContent: string;
    filePath: string;
    originalCode: string;
    suggestedCode: string;
    comment: string;
  }> | null;
  /** diff解析によるsuggest行番号リゾルバ */
  suggestionLineResolver: SuggestionLineResolver | null;
}

/**
 * SummarizationAgent用RequestContext型（モデル設定 + 要約に必要なコンテキスト）
 */
export interface SummarizationAgentRequestContext extends WorkflowRequestContext {
  checkItems: IndexedCheckItem[];
  mrTitle: string;
  mrSourceBranch: string;
  mrTargetBranch: string;
  alreadyStoredSummary: string;
  hasImages: boolean;
}
