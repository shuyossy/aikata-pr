import { CheckItem } from '../checkItem/index.js';
import { Rating } from '../rating/index.js';

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
   * エラーのレビュー結果を生成する
   */
  static error(checkItem: CheckItem, errorMessage: string): ReviewResult {
    // エラー時はダミーの評定を使用
    const errorRating = new Rating('エラー', 'エラーが発生しました');
    return new ReviewResult(checkItem, errorMessage, errorRating, true, errorMessage);
  }
}
