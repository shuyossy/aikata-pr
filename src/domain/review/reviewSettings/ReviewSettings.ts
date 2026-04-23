import { Rating } from '../rating/index.js';
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
  new Rating('-', 'チェック項目の要件がdiffの変更内容に該当しない、または評価不能'),
];

/** デフォルトのMRコメントタイトル */
export const DEFAULT_MR_COMMENT_TITLE = 'AIKATA-PR レビュー結果';

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
    const ratingLabels = new Set(params.ratings.map((r) => r.label));
    for (const label of params.hiddenRatingLabels) {
      if (!ratingLabels.has(label)) {
        throw new Error(`hiddenRatingLabels contains unknown label: ${label}`);
      }
    }
    for (const label of params.suggestEnabledRatingLabels) {
      if (!ratingLabels.has(label)) {
        throw new Error(`suggestEnabledRatingLabels contains unknown label: ${label}`);
      }
    }
    for (const criterion of params.qualityGate.failureCriteria) {
      if (!ratingLabels.has(criterion.ratingLabel)) {
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
    });
  }
}
