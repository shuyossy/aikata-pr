/**
 * GitLab Discussion APIのposition パラメータ
 * postSuggestDiscussionで使用
 */
export interface DiffPosition {
  baseSha: string;
  headSha: string;
  startSha: string;
  oldPath: string;
  newPath: string;
  newLine: number;
}
