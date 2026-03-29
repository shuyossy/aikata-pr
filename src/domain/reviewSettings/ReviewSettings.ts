import { Rating } from '../rating/index.js';

/** デフォルトのコメントフォーマット */
const DEFAULT_COMMENT_FORMAT = '{comment}';

/** デフォルトの評定基準 */
const DEFAULT_RATINGS = [
  new Rating('A', 'チェック項目の要件を完全に満たしている'),
  new Rating('B', '概ね満たしているが軽微な指摘がある'),
  new Rating('C', '要件を満たしていない'),
];

/** ReviewSettingsのコンストラクタパラメータ */
interface ReviewSettingsParams {
  additionalInstructions: string;
  concurrentReviewCount: number | null;
  commentFormat: string;
  ratings: Rating[];
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

  constructor(params: ReviewSettingsParams) {
    if (params.concurrentReviewCount !== null && params.concurrentReviewCount < 1) {
      throw new Error('concurrentReviewCount must be at least 1 or null');
    }
    if (params.ratings.length === 0) {
      throw new Error('ratings must not be empty');
    }
    this.additionalInstructions = params.additionalInstructions;
    this.concurrentReviewCount = params.concurrentReviewCount;
    this.commentFormat = params.commentFormat;
    this.ratings = params.ratings;
  }

  /** デフォルト値でReviewSettingsを生成する */
  static default(): ReviewSettings {
    return new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: DEFAULT_COMMENT_FORMAT,
      ratings: DEFAULT_RATINGS,
    });
  }
}
