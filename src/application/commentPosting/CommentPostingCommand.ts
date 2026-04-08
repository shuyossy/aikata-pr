import { ReviewResult } from '../../domain/reviewResult/index.js';
import { Rating } from '../../domain/rating/index.js';
import type { QualityGateResult } from '../../domain/qualityGate/index.js';

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
}
