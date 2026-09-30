import { ReviewResult } from '../../../domain/review/reviewResult/index.js';
import { Rating } from '../../../domain/review/rating/index.js';
import type { QualityGateResult } from '../../../domain/review/qualityGate/index.js';
import type { ResolvedSuggestion } from '../../../domain/review/suggestion/index.js';
import type { SuggestResolveEntry } from '../reviewExecution/ReviewExecutionDto.js';
import type { ReviewCommentLayout } from '../../../domain/review/reviewSettings/index.js';

/**
 * CommentPostingServiceの入力DTO
 * コメント投稿に必要な情報を保持する
 */
export interface CommentPostingCommand {
  projectId: string;
  mrIid: string;
  results: ReviewResult[];
  ratings: Rating[];
  commitHash: string;
  commitMessage: string;
  hiddenRatingLabels: string[];
  qualityGateResult: QualityGateResult;
  /** 投稿する変更提案 */
  suggestions: ResolvedSuggestion[];
  /** 解決すべき旧suggestディスカッション */
  suggestResolveEntries: SuggestResolveEntry[];
  /** MRのdiff_refs.base_sha */
  baseSha: string;
  /** MRのdiff_refs.head_sha */
  headSha: string;
  /** MRのdiff_refs.start_sha */
  startSha: string;
  /** MRコメントの見出しタイトル */
  mrCommentTitle: string;
  /** レビュー結果コメントの出力レイアウト */
  reviewCommentLayout: ReviewCommentLayout;
  /** チェック項目のAI用content -> 表示用content のマップ */
  checkItemDisplayContents: ReadonlyMap<string, string>;
}
