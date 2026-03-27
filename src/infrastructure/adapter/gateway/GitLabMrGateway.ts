import { MrContext } from '../../../domain/mrContext/index.js';
import type { MrGateway } from '../../../application/shared/port/gateway/index.js';
import type { GitLabApiClient } from '../httpClient/index.js';

/**
 * GitLab APIから返却されるMR情報の型定義
 */
interface GitLabMrInfo {
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
}

/**
 * GitLab APIから返却されるMR変更差分の型定義
 */
interface GitLabMrChanges {
  changes: Array<{
    diff: string;
  }>;
}

/**
 * GitLab APIから返却されるコミット情報の型定義
 */
interface GitLabCommit {
  id: string;
  message: string;
  created_at: string;
}

/**
 * GitLab APIから返却されるcompareエンドポイントの型定義
 */
interface GitLabCompareResult {
  diffs: Array<{
    diff: string;
  }>;
}

/**
 * GitLab APIを利用したMrGatewayの実装
 * GitLab APIレスポンスをドメインオブジェクト（MrContext）に変換する
 */
export class GitLabMrGateway implements MrGateway {
  private readonly client: GitLabApiClient;

  constructor(client: GitLabApiClient) {
    this.client = client;
  }

  /**
   * MR情報とdiffを取得し、MrContextにマッピングする
   */
  async getMrContext(projectId: string, mrIid: string): Promise<MrContext> {
    const [mrInfo, mrChanges] = await Promise.all([
      this.client.get<GitLabMrInfo>(`/projects/${projectId}/merge_requests/${mrIid}`),
      this.client.get<GitLabMrChanges>(`/projects/${projectId}/merge_requests/${mrIid}/changes`),
    ]);

    const diff = this.combineDiffs(mrChanges.changes.map((c) => c.diff));

    return new MrContext({
      title: mrInfo.title,
      description: mrInfo.description,
      sourceBranch: mrInfo.source_branch,
      targetBranch: mrInfo.target_branch,
      diff,
      commitHash: mrInfo.sha,
    });
  }

  /**
   * 指定コミット以降のコミットメッセージを返す
   * sinceCommitHash自体は含まない
   * sinceCommitHashが見つからない場合は全コミットメッセージを返す
   */
  async getCommitsSince(
    projectId: string,
    mrIid: string,
    sinceCommitHash: string,
  ): Promise<string[]> {
    const commits = await this.client.get<GitLabCommit[]>(
      `/projects/${projectId}/merge_requests/${mrIid}/commits`,
    );

    // sinceCommitHashの位置を探す
    const sinceIndex = commits.findIndex((c) => c.id === sinceCommitHash);

    // 見つからない場合は全コミットメッセージを返す
    if (sinceIndex === -1) {
      return commits.map((c) => c.message);
    }

    // sinceCommitHash以降（sinceCommitHash自体は含まない）のコミットメッセージを返す
    return commits.slice(0, sinceIndex).map((c) => c.message);
  }

  /**
   * 指定コミット以降のdiffを返す
   * MRの現在のshaを取得し、compareエンドポイントで差分を取得する
   */
  async getDiffSince(projectId: string, mrIid: string, sinceCommitHash: string): Promise<string> {
    // MR情報から現在のshaを取得
    const mrInfo = await this.client.get<GitLabMrInfo>(
      `/projects/${projectId}/merge_requests/${mrIid}`,
    );

    // compareエンドポイントで差分を取得
    const compareResult = await this.client.get<GitLabCompareResult>(
      `/projects/${projectId}/repository/compare?from=${sinceCommitHash}&to=${mrInfo.sha}`,
    );

    return this.combineDiffs(compareResult.diffs.map((d) => d.diff));
  }

  /**
   * 複数のdiff文字列を改行で結合する
   */
  private combineDiffs(diffs: string[]): string {
    if (diffs.length === 0) {
      return '';
    }
    return diffs.join('\n');
  }
}
