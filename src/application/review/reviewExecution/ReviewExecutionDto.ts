import { ReviewResult } from '../../../domain/review/reviewResult/index.js';

/**
 * ReviewExecutionServiceの出力DTO
 * AIレビュー実行結果のみを保持する（コメント投稿・品質ゲートの結果は含まない）
 */
export interface ReviewExecutionDto {
  results: ReviewResult[];
  commitHash: string;
  commitMessage: string;
}
