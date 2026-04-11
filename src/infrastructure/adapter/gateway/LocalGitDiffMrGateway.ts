import { execFileSync } from 'node:child_process';
import { MrContext } from '../../../domain/review/mrContext/index.js';
import type { MrGateway } from '../../../application/shared/port/gateway/index.js';
import type { GitLabApiClient } from '../httpClient/index.js';
import { combineDiffs } from './combineDiffs.js';
import { getLogger } from '../../../lib/logger.js';

/**
 * GitLab APIから返却されるMR変更差分の型定義（access_raw_diffs用）
 */
interface GitLabMrChanges {
  changes: Array<{
    old_path: string;
    new_path: string;
    diff: string;
  }>;
}

/**
 * execFileSyncの共通オプション（cwdを除く）
 */
const GIT_EXEC_OPTIONS = {
  encoding: 'utf-8' as const,
  maxBuffer: 50 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
};

/**
 * ローカルgitリポジトリからのdiff取得を優先し、失敗時にAPIにフォールバックするMrGatewayデコレータ
 *
 * getMrContext: APIでメタデータ取得後、ローカルgit diffを試行。失敗時はAPI(access_raw_diffs=true)にフォールバック
 * getDiffSince: ローカルgit diffを試行。失敗時はfallbackGatewayに委譲
 * getCommitsSince: fallbackGatewayにそのまま委譲
 */
export class LocalGitDiffMrGateway implements MrGateway {
  constructor(
    private readonly projectDir: string,
    private readonly fallbackGateway: MrGateway,
    private readonly client: GitLabApiClient,
  ) {}

  async getMrContext(projectId: string, mrIid: string): Promise<MrContext> {
    // APIからMRメタデータを取得（title, description, branches, commitHash, commitMessage）
    const mrContext = await this.fallbackGateway.getMrContext(projectId, mrIid);

    // ローカルgit diffを試行
    const localDiff = this.tryLocalMrDiff(mrContext.targetBranch);
    if (localDiff !== null) {
      getLogger().info('MR diff retrieved from local git repository');
      return new MrContext({
        title: mrContext.title,
        description: mrContext.description,
        sourceBranch: mrContext.sourceBranch,
        targetBranch: mrContext.targetBranch,
        diff: localDiff,
        commitHash: mrContext.commitHash,
        commitMessage: mrContext.commitMessage,
      });
    }

    // ローカルgit失敗 → API(access_raw_diffs=true)にフォールバック
    getLogger().info('Local git diff failed, falling back to API with access_raw_diffs=true');
    try {
      const mrChanges = await this.client.get<GitLabMrChanges>(
        `/projects/${projectId}/merge_requests/${mrIid}/changes?access_raw_diffs=true`,
      );
      const apiDiff = combineDiffs(
        mrChanges.changes.map((c) => ({ oldPath: c.old_path, newPath: c.new_path, diff: c.diff })),
      );
      getLogger().info('MR diff retrieved from API with access_raw_diffs=true');
      return new MrContext({
        title: mrContext.title,
        description: mrContext.description,
        sourceBranch: mrContext.sourceBranch,
        targetBranch: mrContext.targetBranch,
        diff: apiDiff,
        commitHash: mrContext.commitHash,
        commitMessage: mrContext.commitMessage,
      });
    } catch (apiError) {
      throw new Error(
        `Failed to retrieve MR diff from both local git and API: API error: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
        { cause: apiError },
      );
    }
  }

  async getDiffSince(
    projectId: string,
    mrIid: string,
    sinceCommitHash: string,
    currentCommitHash: string,
  ): Promise<string> {
    // ローカルgit diffを試行
    const localDiff = this.tryLocalDiffBetween(sinceCommitHash, currentCommitHash);
    if (localDiff !== null) {
      getLogger().info('Incremental diff retrieved from local git repository');
      return localDiff;
    }

    // ローカルgit失敗 → fallbackGatewayに委譲
    getLogger().info('Local git diff failed, falling back to API for incremental diff');
    return this.fallbackGateway.getDiffSince(projectId, mrIid, sinceCommitHash, currentCommitHash);
  }

  async getCommitsSince(
    projectId: string,
    mrIid: string,
    sinceCommitHash: string,
  ): Promise<string[]> {
    return this.fallbackGateway.getCommitsSince(projectId, mrIid, sinceCommitHash);
  }

  /**
   * ローカルgitリポジトリからMR diffを取得する
   * 失敗時はnullを返す
   */
  private tryLocalMrDiff(targetBranch: string): string | null {
    try {
      // ターゲットブランチをフェッチ
      execFileSync('git', ['fetch', 'origin', targetBranch], {
        cwd: this.projectDir,
        ...GIT_EXEC_OPTIONS,
      });

      // 3-dot diff: ターゲットブランチとの共通祖先からHEADまでの差分
      const diff = execFileSync('git', ['diff', `origin/${targetBranch}...HEAD`], {
        cwd: this.projectDir,
        ...GIT_EXEC_OPTIONS,
      });

      return diff;
    } catch (error) {
      getLogger().warn(
        `Failed to get MR diff from local git: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * ローカルgitリポジトリから2つのコミット間のdiffを取得する
   * 失敗時はnullを返す
   */
  private tryLocalDiffBetween(fromCommit: string, toCommit: string): string | null {
    try {
      const diff = execFileSync('git', ['diff', `${fromCommit}..${toCommit}`], {
        cwd: this.projectDir,
        ...GIT_EXEC_OPTIONS,
      });

      return diff;
    } catch (error) {
      getLogger().warn(
        `Failed to get diff between commits from local git: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
