/**
 * レビュー結果の保存形式
 * storeReviewResultツールと結果読み込みで共通利用する
 */
export interface StoredReviewResult {
  checkItemContent: string;
  ratingLabel: string;
  ratingDefinition: string;
  comment: string;
  isError: boolean;
  errorMessage?: string;
}
