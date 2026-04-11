import { CheckItem } from '../checkItem/index.js';
import { Rating } from '../rating/index.js';

/** エラー時の評定ラベル */
export const ERROR_RATING_LABEL = 'エラー';

/** エラー時の評定定義 */
export const ERROR_RATING_DEFINITION = 'エラーが発生しました';

/**
 * レビュー結果エンティティ
 * 一つのチェック項目に対するAIレビューの結果を表す
 */
export class ReviewResult {
  readonly checkItem: CheckItem;
  readonly comment: string;
  readonly rating: Rating;
  readonly isError: boolean;
  readonly errorMessage?: string;

  private constructor(
    checkItem: CheckItem,
    comment: string,
    rating: Rating,
    isError: boolean,
    errorMessage?: string,
  ) {
    this.checkItem = checkItem;
    this.comment = comment;
    this.rating = rating;
    this.isError = isError;
    this.errorMessage = errorMessage;
  }

  /**
   * 正常なレビュー結果を生成する
   */
  static success(checkItem: CheckItem, rating: Rating, comment: string): ReviewResult {
    return new ReviewResult(checkItem, comment, rating, false);
  }

  /**
   * 全てのレビュー結果がエラーかどうかを判定する
   * 結果が空の場合はfalseを返す
   */
  static allAreErrors(results: ReviewResult[]): boolean {
    return results.length > 0 && results.every((r) => r.isError);
  }

  /**
   * 全てのレビュー結果が非エラーかつ指定された非表示評定ラベルに該当するか判定する
   * 結果が空の場合はfalseを返す
   */
  static allAreHidden(results: ReviewResult[], hiddenRatingLabels: string[]): boolean {
    return (
      results.length > 0 &&
      results.every((r) => !r.isError && hiddenRatingLabels.includes(r.rating.label))
    );
  }

  /**
   * エラーのレビュー結果を生成する
   */
  static error(checkItem: CheckItem, errorMessage: string): ReviewResult {
    const errorRating = new Rating(ERROR_RATING_LABEL, ERROR_RATING_DEFINITION);
    return new ReviewResult(checkItem, errorMessage, errorRating, true, errorMessage);
  }
}
