import { ReviewResult } from '../../domain/reviewResult/index.js';

/**
 * ExecuteReviewサービスの出力DTO
 */
export interface ExecuteReviewDto {
  results: ReviewResult[];
  commitHash: string;
  commentPosted: boolean;
  /** 全てのレビュー結果がエラーかどうか */
  allResultsAreErrors: boolean;
  /** 品質ゲートを通過したかどうか */
  qualityGatePassed: boolean;
}
