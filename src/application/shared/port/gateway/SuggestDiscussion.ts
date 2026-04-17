/**
 * GitLab上のAIKATA-PRによるsuggest discussionの情報
 * getSuggestDiscussionsの返却型として使用
 */
export interface SuggestDiscussion {
  discussionId: string;
  checkItemContent: string;
  filePath: string;
  originalCode: string;
  suggestedCode: string;
  comment: string;
  hasChangedSinceNote: boolean;
}
