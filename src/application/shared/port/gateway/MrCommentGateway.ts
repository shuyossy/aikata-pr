/**
 * MRコメントの型定義
 */
export interface MrComment {
  id: number;
  body: string;
  createdAt: string;
}

/**
 * MRコメントを操作するためのゲートウェイインターフェース
 */
export interface MrCommentGateway {
  getComments(projectId: string, mrIid: string): Promise<MrComment[]>;
  postComment(projectId: string, mrIid: string, body: string): Promise<void>;
}
