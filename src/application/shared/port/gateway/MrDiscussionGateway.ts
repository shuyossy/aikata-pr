/**
 * MRコメントの型定義
 */
export interface MrComment {
  id: number;
  body: string;
  createdAt: string;
}

/**
 * MRディスカッションを操作するためのゲートウェイインターフェース
 */
export interface MrDiscussionGateway {
  getDiscussions(projectId: string, mrIid: string): Promise<MrComment[]>;
  postDiscussion(projectId: string, mrIid: string, body: string): Promise<void>;
  postNote(projectId: string, mrIid: string, body: string): Promise<void>;
}
