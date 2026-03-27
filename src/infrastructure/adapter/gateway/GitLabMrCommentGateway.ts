import type {
  MrCommentGateway,
  MrComment,
} from '../../../application/shared/port/gateway/index.js';
import type { GitLabApiClient } from '../httpClient/index.js';

/**
 * GitLab APIから返却されるノート情報の型定義
 */
interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
}

/**
 * GitLab APIを利用したMrCommentGatewayの実装
 * MRのコメント（ノート）の取得・投稿を行う
 */
export class GitLabMrCommentGateway implements MrCommentGateway {
  private readonly client: GitLabApiClient;

  constructor(client: GitLabApiClient) {
    this.client = client;
  }

  /**
   * MRのコメント一覧を取得する
   */
  async getComments(projectId: string, mrIid: string): Promise<MrComment[]> {
    const notes = await this.client.get<GitLabNote[]>(
      `/projects/${projectId}/merge_requests/${mrIid}/notes`,
    );

    return notes.map((note) => ({
      id: note.id,
      body: note.body,
      createdAt: note.created_at,
    }));
  }

  /**
   * MRにコメントを投稿する
   */
  async postComment(projectId: string, mrIid: string, body: string): Promise<void> {
    await this.client.post(`/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
  }
}
