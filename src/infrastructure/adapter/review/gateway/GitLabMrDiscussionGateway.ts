import type {
  MrDiscussionGateway,
  MrComment,
  SuggestDiscussion,
  DiffPosition,
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
  async getReviewDiscussions(projectId: string, mrIid: string): Promise<MrComment[]> {
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
  async postReviewDiscussion(projectId: string, mrIid: string, body: string): Promise<void> {
    await this.client.post(`/projects/${projectId}/merge_requests/${mrIid}/discussions`, { body });
  }

  /**
   * MRにノート（通常コメント）を投稿する
   */
  async postNote(projectId: string, mrIid: string, body: string): Promise<void> {
    await this.client.post(`/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
  }

  /**
   * MRのAIKATA-PRによるsuggest discussion一覧を取得する
   * 実装はTask 7で行う
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getSuggestDiscussions(projectId: string, mrIid: string): Promise<SuggestDiscussion[]> {
    return [];
  }

  /**
   * MRにsuggest用のdiff discussionを投稿する
   * 実装はTask 7で行う
   */
  async postSuggestDiscussion(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    projectId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mrIid: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    body: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    position: DiffPosition,
  ): Promise<void> {
    // 実装はTask 7で行う
  }

  /**
   * MRのディスカッションをresolveする
   * 実装はTask 7で行う
   */
  async resolveDiscussion(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    projectId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mrIid: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    discussionId: string,
  ): Promise<void> {
    // 実装はTask 7で行う
  }
}
