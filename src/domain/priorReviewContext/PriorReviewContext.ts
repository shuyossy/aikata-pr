import { ReviewResult } from '../reviewResult/index.js';

/**
 * 前回レビューコンテキスト値オブジェクト
 * 前回のレビュー結果とその後の変更情報を保持する
 */
interface PriorReviewContextParams {
  results: ReviewResult[];
  commitMessages: string[];
  diffSincePrior: string;
}

export class PriorReviewContext {
  readonly results: ReviewResult[];
  readonly commitMessages: string[];
  readonly diffSincePrior: string;

  constructor(params: PriorReviewContextParams) {
    this.results = params.results;
    this.commitMessages = params.commitMessages;
    this.diffSincePrior = params.diffSincePrior;
  }
}
