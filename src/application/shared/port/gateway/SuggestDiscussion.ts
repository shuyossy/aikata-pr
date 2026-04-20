/**
 * GitLab上のAIKATA-PRによるsuggest discussionの情報
 * getSuggestDiscussionsの返却型として使用
 *
 * 位置情報はGitLab APIのnote positionフィールドおよびsuggestion構文から取得する
 */
export interface SuggestDiscussion {
  discussionId: string;
  checkItemContent: string;
  /** ファイルパス（GitLab note positionのnew_pathから取得） */
  filePath: string;
  hasChangedSinceNote: boolean;
  /** アンカー行番号（GitLab note positionのnew_lineから取得、取得不可の場合はnull） */
  newLine: number | null;
  /** suggestion:-X の値（suggestion構文から取得） */
  linesAbove: number;
  /** suggestion:+Y の値（suggestion構文から取得） */
  linesBelow: number;
}
