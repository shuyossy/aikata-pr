import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitLabMrGateway } from '../GitLabMrGateway.js';
import { MrContext } from '../../../../domain/mrContext/index.js';

/**
 * GitLabApiClientのモックインターフェース
 */
interface MockGitLabApiClient {
  get: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

describe('GitLabMrGateway', () => {
  let mockClient: MockGitLabApiClient;
  let gateway: GitLabMrGateway;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      getAll: vi.fn(),
      post: vi.fn(),
    };
    gateway = new GitLabMrGateway(
      mockClient as unknown as ConstructorParameters<typeof GitLabMrGateway>[0],
    );
  });

  describe('getMrContext', () => {
    it('MR情報とdiffを正しくMrContextにマッピングする', async () => {
      // MR基本情報のレスポンス
      const mrInfoResponse = {
        title: 'feat: add new feature',
        description: 'This MR adds a new feature',
        source_branch: 'feature/new-feature',
        target_branch: 'main',
        sha: 'abc123def456',
        diff_refs: {
          base_sha: 'base000',
          head_sha: 'abc123def456',
          start_sha: 'start000',
        },
      };

      // MR変更差分のレスポンス
      const mrChangesResponse = {
        changes: [
          {
            old_path: 'file1.ts',
            new_path: 'file1.ts',
            diff: '@@ -1,3 +1,4 @@\n+import { foo } from "bar";\n',
          },
          {
            old_path: 'file2.ts',
            new_path: 'file2.ts',
            diff: '@@ -10,3 +10,5 @@\n+export const baz = 1;\n',
          },
        ],
      };

      // 最新コミットのレスポンス
      const commitsResponse = [
        {
          id: 'abc123def456',
          message: 'feat: add new feature\n\nDetailed description',
          created_at: '2026-03-03T00:00:00Z',
        },
      ];

      mockClient.get
        .mockResolvedValueOnce(mrInfoResponse)
        .mockResolvedValueOnce(mrChangesResponse)
        .mockResolvedValueOnce(commitsResponse);

      const result = await gateway.getMrContext('123', '42');

      // API呼び出しの検証
      expect(mockClient.get).toHaveBeenCalledWith('/projects/123/merge_requests/42');
      expect(mockClient.get).toHaveBeenCalledWith(
        '/projects/123/merge_requests/42/changes?access_raw_diffs=true',
      );
      expect(mockClient.get).toHaveBeenCalledWith(
        '/projects/123/merge_requests/42/commits?per_page=1',
      );

      // マッピング結果の検証
      expect(result).toBeInstanceOf(MrContext);
      expect(result.title).toBe('feat: add new feature');
      expect(result.description).toBe('This MR adds a new feature');
      expect(result.sourceBranch).toBe('feature/new-feature');
      expect(result.targetBranch).toBe('main');
      expect(result.commitHash).toBe('abc123def456');
      // コミットメッセージは1行目のみ
      expect(result.commitMessage).toBe('feat: add new feature');
      // 複数のdiffがファイルパスヘッダー付きで結合されること
      expect(result.diff).toBe(
        'diff --git a/file1.ts b/file1.ts\n--- a/file1.ts\n+++ b/file1.ts\n@@ -1,3 +1,4 @@\n+import { foo } from "bar";\n' +
          '\n' +
          'diff --git a/file2.ts b/file2.ts\n--- a/file2.ts\n+++ b/file2.ts\n@@ -10,3 +10,5 @@\n+export const baz = 1;\n',
      );
    });

    it('changesが空の場合、diffは空文字列となる', async () => {
      const mrInfoResponse = {
        title: 'chore: empty MR',
        description: '',
        source_branch: 'feature/empty',
        target_branch: 'main',
        sha: 'empty123',
        diff_refs: {
          base_sha: 'base000',
          head_sha: 'empty123',
          start_sha: 'start000',
        },
      };

      const mrChangesResponse = {
        changes: [],
      };

      // 空のコミットレスポンス
      const commitsResponse: unknown[] = [];

      mockClient.get
        .mockResolvedValueOnce(mrInfoResponse)
        .mockResolvedValueOnce(mrChangesResponse)
        .mockResolvedValueOnce(commitsResponse);

      const result = await gateway.getMrContext('123', '10');

      expect(result.diff).toBe('');
      expect(result.commitMessage).toBe('');
    });
  });

  describe('getCommitsSince', () => {
    it('指定コミット以降のコミットメッセージを返す', async () => {
      // GitLab APIのコミットレスポンス（新しい順）
      const commitsResponse = [
        { id: 'commit3', message: 'feat: third commit', created_at: '2026-03-03T00:00:00Z' },
        { id: 'commit2', message: 'fix: second commit', created_at: '2026-03-02T00:00:00Z' },
        { id: 'commit1', message: 'feat: first commit', created_at: '2026-03-01T00:00:00Z' },
        {
          id: 'sinceCommit',
          message: 'chore: since this commit',
          created_at: '2026-02-28T00:00:00Z',
        },
        { id: 'olderCommit', message: 'chore: older commit', created_at: '2026-02-27T00:00:00Z' },
      ];

      mockClient.getAll.mockResolvedValueOnce(commitsResponse);

      const result = await gateway.getCommitsSince('123', '42', 'sinceCommit');

      expect(mockClient.getAll).toHaveBeenCalledWith('/projects/123/merge_requests/42/commits');
      // sinceCommit以降（sinceCommit自体は含まない）のコミットメッセージを返す
      expect(result).toEqual(['feat: third commit', 'fix: second commit', 'feat: first commit']);
    });

    it('指定コミットが見つからない場合は全コミットメッセージを返す', async () => {
      const commitsResponse = [
        { id: 'commit2', message: 'fix: second commit', created_at: '2026-03-02T00:00:00Z' },
        { id: 'commit1', message: 'feat: first commit', created_at: '2026-03-01T00:00:00Z' },
      ];

      mockClient.getAll.mockResolvedValueOnce(commitsResponse);

      const result = await gateway.getCommitsSince('123', '42', 'nonExistentCommit');

      expect(result).toEqual(['fix: second commit', 'feat: first commit']);
    });

    it('コミットが空の場合は空配列を返す', async () => {
      mockClient.getAll.mockResolvedValueOnce([]);

      const result = await gateway.getCommitsSince('123', '42', 'someCommit');

      expect(result).toEqual([]);
    });
  });

  describe('getDiffSince', () => {
    it('指定コミット以降のdiffを返す', async () => {
      const compareResponse = {
        diffs: [
          {
            old_path: 'changed.ts',
            new_path: 'changed.ts',
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          },
          {
            old_path: 'added.ts',
            new_path: 'added.ts',
            diff: '@@ -0,0 +1 @@\n+content\n',
          },
        ],
      };

      mockClient.get.mockResolvedValueOnce(compareResponse);

      const result = await gateway.getDiffSince('123', '42', 'sinceCommitHash', 'currentSha123');

      expect(mockClient.get).toHaveBeenCalledWith(
        '/projects/123/repository/compare?from=sinceCommitHash&to=currentSha123',
      );

      expect(result).toBe(
        'diff --git a/changed.ts b/changed.ts\n--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old\n+new\n' +
          '\n' +
          'diff --git a/added.ts b/added.ts\n--- a/added.ts\n+++ b/added.ts\n@@ -0,0 +1 @@\n+content\n',
      );
    });

    it('diffが空の場合は空文字列を返す', async () => {
      const compareResponse = {
        diffs: [],
      };

      mockClient.get.mockResolvedValueOnce(compareResponse);

      const result = await gateway.getDiffSince('123', '42', 'sinceCommitHash', 'currentSha456');

      expect(result).toBe('');
    });

    it('既にヘッダーが含まれるdiffに対して重複ヘッダーを追加しない', async () => {
      const compareResponse = {
        diffs: [
          {
            old_path: 'file.ts',
            new_path: 'file.ts',
            diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
      };

      mockClient.get.mockResolvedValueOnce(compareResponse);

      const result = await gateway.getDiffSince('123', '42', 'fromSha', 'toSha');

      // diff --git ヘッダーは追加されるが --- a/ と +++ b/ は重複しない
      expect(result).toBe(
        'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
      );
    });

    it('リネームされたファイルのdiffにold_pathとnew_pathが反映される', async () => {
      const compareResponse = {
        diffs: [
          {
            old_path: 'old/file.ts',
            new_path: 'new/file.ts',
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
      };

      mockClient.get.mockResolvedValueOnce(compareResponse);

      const result = await gateway.getDiffSince('123', '42', 'fromSha', 'toSha');

      expect(result).toBe(
        'diff --git a/old/file.ts b/new/file.ts\n--- a/old/file.ts\n+++ b/new/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
      );
    });
  });
});
