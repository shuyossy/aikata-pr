import { Checklist } from '../../domain/checklist/index.js';
import { ReviewSettings } from '../../domain/reviewSettings/index.js';

/**
 * ExecuteReviewサービスの入力DTO
 */
export interface ExecuteReviewCommand {
  userId: string;
  projectId: string;
  mrIid: string;
  checklist: Checklist;
  reviewSettings: ReviewSettings;
  skillsPaths: string[];
  projectDir: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  gitlabToken: string;
  treeMaxDepth: number | undefined;
  commentLanguage: string;
}
