import { Rating, OUT_OF_SCOPE_RATING, OUT_OF_SCOPE_RATING_LABEL } from '../rating/index.js';
import { QualityGate } from '../qualityGate/index.js';

/** デフォルトのコメントフォーマット */
const DEFAULT_COMMENT_FORMAT = `【評価理由・根拠】
<具体的な評価理由や根拠を記載>

【改善提案】
<具体的な改善提案を記載>`;

/** デフォルトの評定基準 */
const DEFAULT_RATINGS = [
  new Rating('A', 'チェック項目の要件を完全に満たしている'),
  new Rating('B', '概ね満たしているが軽微な指摘がある'),
  new Rating('C', '要件を満たしていない'),
  // out-of-scope評定は予約定数を再利用（ユーザが評定リストから外した場合でも
  // storeReviewResult / CommentParser 側でフォールバック格納可能）
  OUT_OF_SCOPE_RATING,
];

/** デフォルトのMRコメントタイトル */
export const DEFAULT_MR_COMMENT_TITLE = 'AIKATA-PR レビュー結果';

/** 選択可能なレビューコメントレイアウトの一覧 */
export const REVIEW_COMMENT_LAYOUTS = ['table', 'sections'] as const;

/**
 * レビュー結果コメントの出力レイアウト
 * - table: チェック項目・評定・コメントの3列テーブル（従来形式）
 * - sections: チェック項目・評定の2列サマリテーブル + テーブル外に詳細をMarkdownで展開
 */
export type ReviewCommentLayout = (typeof REVIEW_COMMENT_LAYOUTS)[number];

/** デフォルトのレビューコメントレイアウト */
export const DEFAULT_REVIEW_COMMENT_LAYOUT: ReviewCommentLayout = 'table';

/** ReviewSettingsのコンストラクタパラメータ */
interface ReviewSettingsParams {
  additionalInstructions: string;
  concurrentReviewCount: number | null;
  commentFormat: string;
  ratings: Rating[];
  hiddenRatingLabels: string[];
  suggestEnabledRatingLabels: string[];
  qualityGate: QualityGate;
  mrCommentTitle: string;
  reviewCommentLayout: ReviewCommentLayout;
}

/**
 * レビュー設定の値オブジェクト
 * AIによるレビュー実行時にユーザがアレンジ可能な設定項目を保持する
 */
export class ReviewSettings {
  readonly additionalInstructions: string;
  readonly concurrentReviewCount: number | null;
  readonly commentFormat: string;
  readonly ratings: Rating[];
  readonly hiddenRatingLabels: string[];
  readonly suggestEnabledRatingLabels: string[];
  readonly qualityGate: QualityGate;
  readonly mrCommentTitle: string;
  readonly reviewCommentLayout: ReviewCommentLayout;

  constructor(params: ReviewSettingsParams) {
    if (params.concurrentReviewCount !== null && params.concurrentReviewCount < 1) {
      throw new Error('concurrentReviewCount must be at least 1 or null');
    }
    if (params.ratings.length === 0) {
      throw new Error('ratings must not be empty');
    }
    if (params.mrCommentTitle.length === 0) {
      throw new Error('mrCommentTitle must not be empty');
    }
    if (!REVIEW_COMMENT_LAYOUTS.includes(params.reviewCommentLayout)) {
      throw new Error(
        `reviewCommentLayout must be one of: ${REVIEW_COMMENT_LAYOUTS.join(', ')}. Got: ${params.reviewCommentLayout}`,
      );
    }
    const ratingLabels = new Set(params.ratings.map((r) => r.label));
    // out-of-scope の予約フォールバックラベルは ratings に未登録でも常に許容する
    const isAcceptedLabel = (label: string): boolean =>
      ratingLabels.has(label) || label === OUT_OF_SCOPE_RATING_LABEL;
    for (const label of params.hiddenRatingLabels) {
      if (!isAcceptedLabel(label)) {
        throw new Error(`hiddenRatingLabels contains unknown label: ${label}`);
      }
    }
    for (const label of params.suggestEnabledRatingLabels) {
      if (!isAcceptedLabel(label)) {
        throw new Error(`suggestEnabledRatingLabels contains unknown label: ${label}`);
      }
    }
    for (const criterion of params.qualityGate.failureCriteria) {
      if (!isAcceptedLabel(criterion.ratingLabel)) {
        throw new Error(
          `qualityGate failureCriteria contains unknown rating label: ${criterion.ratingLabel}`,
        );
      }
    }
    this.additionalInstructions = params.additionalInstructions;
    this.concurrentReviewCount = params.concurrentReviewCount;
    this.commentFormat = params.commentFormat;
    this.ratings = params.ratings;
    this.hiddenRatingLabels = params.hiddenRatingLabels;
    this.suggestEnabledRatingLabels = params.suggestEnabledRatingLabels;
    this.qualityGate = params.qualityGate;
    this.mrCommentTitle = params.mrCommentTitle;
    this.reviewCommentLayout = params.reviewCommentLayout;
  }

  /** suggestが有効かどうか判定する */
  isSuggestEnabled(): boolean {
    return this.suggestEnabledRatingLabels.length > 0;
  }

  /** デフォルト値でReviewSettingsを生成する */
  static default(): ReviewSettings {
    return new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: DEFAULT_COMMENT_FORMAT,
      ratings: DEFAULT_RATINGS,
      hiddenRatingLabels: [],
      suggestEnabledRatingLabels: ['C'],
      qualityGate: QualityGate.none(),
      mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
      reviewCommentLayout: DEFAULT_REVIEW_COMMENT_LAYOUT,
    });
  }
}
