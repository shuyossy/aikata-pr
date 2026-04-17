import type { SuggestDiscussion } from './SuggestDiscussion.js';
import type { DiffPosition } from './DiffPosition.js';

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
  // レビューコメント操作
  getReviewDiscussions(projectId: string, mrIid: string): Promise<MrComment[]>;
  postReviewDiscussion(projectId: string, mrIid: string, body: string): Promise<void>;
  postNote(projectId: string, mrIid: string, body: string): Promise<void>;

  // サジェスト操作
  getSuggestDiscussions(projectId: string, mrIid: string): Promise<SuggestDiscussion[]>;
  postSuggestDiscussion(
    projectId: string,
    mrIid: string,
    body: string,
    position: DiffPosition,
  ): Promise<void>;
  resolveDiscussion(projectId: string, mrIid: string, discussionId: string): Promise<void>;
}
