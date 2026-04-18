import type {
  MrDiscussionGateway,
  MrComment,
  SuggestDiscussion,
  DiffPosition,
} from '../../../../application/shared/port/gateway/index.js';
import { SuggestCommentParser } from '../../../../application/shared/comment/SuggestCommentParser.js';
import type { GitLabApiClient } from '../../httpClient/index.js';

/**
 * system noteに含まれる「diff変更済み」を示すキーワード
 */
const CHANGED_KEYWORDS = ['changed this line', 'changed this', 'compare changes'];

/**
 * GitLab APIから返却されるノート情報の型定義
 */
interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
  system: boolean;
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
   * suggestマーカー付きのディスカッションのみを抽出し、メタデータをパースして返す
   */
  async getSuggestDiscussions(projectId: string, mrIid: string): Promise<SuggestDiscussion[]> {
    const discussions = await this.client.getAll<GitLabDiscussion>(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
    );

    const results: SuggestDiscussion[] = [];

    for (const discussion of discussions) {
      if (discussion.notes.length === 0) {
        continue;
      }

      const firstNote = discussion.notes[0];

      // SuggestCommentParserでメタデータを抽出（マーカー判定含む）
      const suggestData = SuggestCommentParser.parse(firstNote.body);
      if (!suggestData) {
        continue;
      }

      // system noteに変更キーワードが含まれているか確認
      const hasChangedSinceNote = this.hasChangedSystemNote(discussion.notes);

      results.push({
        discussionId: discussion.id,
        checkItemContent: suggestData.checkItemContent,
        filePath: suggestData.filePath,
        originalCode: suggestData.originalCode,
        suggestedCode: suggestData.suggestedCode,
        comment: suggestData.comment,
        hasChangedSinceNote,
      });
    }

    return results;
  }

  /**
   * MRにsuggest用のdiff discussionを投稿する
   */
  async postSuggestDiscussion(
    projectId: string,
    mrIid: string,
    body: string,
    position: DiffPosition,
  ): Promise<void> {
    await this.client.post(`/projects/${projectId}/merge_requests/${mrIid}/discussions`, {
      body,
      position: {
        position_type: 'text',
        base_sha: position.baseSha,
        head_sha: position.headSha,
        start_sha: position.startSha,
        old_path: position.oldPath,
        new_path: position.newPath,
        new_line: position.newLine,
      },
    });
  }

  /**
   * MRのディスカッションに返信ノートを追加する
   */
  async replyToDiscussion(
    projectId: string,
    mrIid: string,
    discussionId: string,
    body: string,
  ): Promise<void> {
    await this.client.post(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}/notes`,
      { body },
    );
  }

  /**
   * MRのディスカッションをresolveする
   */
  async resolveDiscussion(projectId: string, mrIid: string, discussionId: string): Promise<void> {
    await this.client.put(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
      { resolved: true },
    );
  }

  /**
   * ディスカッション内のnote群にdiff変更を示すsystem noteが含まれるか判定する
   */
  private hasChangedSystemNote(notes: GitLabNote[]): boolean {
    return notes.some(
      (note) =>
        note.system === true && CHANGED_KEYWORDS.some((keyword) => note.body.includes(keyword)),
    );
  }
}
