import { Checklist } from '../../domain/checklist/index.js';
import { ReviewSettings } from '../../domain/reviewSettings/index.js';

/**
 * ReviewExecutionServiceの入力DTO
 * AIレビュー実行に必要な情報のみを保持する（コメント投稿・品質ゲートは含まない）
 */
export interface ReviewExecutionCommand {
  userId: string;
  projectId: string;
  mrIid: string;
  gitlabToken: string;
  checklist: Checklist;
  reviewSettings: ReviewSettings;
  skillsPaths: string[];
  projectDir: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  treeMaxDepth: number | undefined;
  commentLanguage: string;
  openaiReasoningEffort: string | undefined;
  maxContextLength: number | undefined;
}
