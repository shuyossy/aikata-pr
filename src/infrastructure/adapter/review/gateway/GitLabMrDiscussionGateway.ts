import type {
  MrDiscussionGateway,
  MrComment,
} from '../../../../application/shared/port/gateway/index.js';
import type { GitLabApiClient } from '../../httpClient/index.js';

/**
 * GitLab APIから返却されるノート情報の型定義
 */
interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
}

/**
 * GitLab APIから返却されるディスカッション情報の型定義
 */
interface GitLabDiscussion {
  id: string;
  individual_note: boolean;
  notes: GitLabNote[];
}

/**
 * GitLab APIを利用したMrDiscussionGatewayの実装
 * MRのディスカッションの取得・投稿を行う
 */
export class GitLabMrDiscussionGateway implements MrDiscussionGateway {
  private readonly client: GitLabApiClient;

  constructor(client: GitLabApiClient) {
    this.client = client;
  }

  /**
   * MRのディスカッション一覧を取得し、各ディスカッションの最初のnoteをMrComment形式で返す
   */
  async getDiscussions(projectId: string, mrIid: string): Promise<MrComment[]> {
    const discussions = await this.client.getAll<GitLabDiscussion>(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
    );

    return discussions
      .filter((d) => d.notes.length > 0)
      .map((d) => ({
        id: d.notes[0].id,
        body: d.notes[0].body,
        createdAt: d.notes[0].created_at,
      }));
  }

  /**
   * MRに新規ディスカッションを投稿する
   */
  async postDiscussion(projectId: string, mrIid: string, body: string): Promise<void> {
    await this.client.post(`/projects/${projectId}/merge_requests/${mrIid}/discussions`, { body });
  }

  /**
   * MRにノート（通常コメント）を投稿する
   */
  async postNote(projectId: string, mrIid: string, body: string): Promise<void> {
    await this.client.post(`/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
  }
}
