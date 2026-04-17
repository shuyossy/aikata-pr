import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { LocalGitDiffMrGateway } from '../LocalGitDiffMrGateway.js';
import { MrContext } from '../../../../domain/review/mrContext/index.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';
import type { MrGateway } from '../../../../application/shared/port/gateway/index.js';
import type { GitLabApiClient } from '../../../adapter/httpClient/index.js';

/**
 * テスト用の一時gitリポジトリを作成するヘルパー
 * origin（bare）とワーキングリポジトリを作成し、ブランチ構成をシミュレートする
 */
function createTestRepoWithBranches(): {
  workDir: string;
  bareDir: string;
  targetBranch: string;
  baseCommitHash: string;
  headCommitHash: string;
} {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'aikata-git-diff-test-'));
  const bareDir = path.join(tmpBase, 'origin.git');
  const workDir = path.join(tmpBase, 'work');

  // bareリポジトリ作成（originとして使用）
  fs.mkdirSync(bareDir);
  execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' });

  // ワーキングリポジトリ作成
  execFileSync('git', ['clone', bareDir, workDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, stdio: 'pipe' });

  // mainブランチに初期コミット
  fs.writeFileSync(path.join(workDir, 'base.txt'), 'base content\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd: workDir, stdio: 'pipe' });

  const baseCommitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();

  // featureブランチに変更を追加
  execFileSync('git', ['checkout', '-b', 'feature/test'], { cwd: workDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(workDir, 'new-file.ts'), 'export const hello = "world";\n');
  execFileSync('git', ['add', 'new-file.ts'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'add new file'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['push', 'origin', 'feature/test'], { cwd: workDir, stdio: 'pipe' });

  const headCommitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workDir,
    encoding: 'utf-8',
  }).trim();

  return { workDir, bareDir, targetBranch: 'main', baseCommitHash, headCommitHash };
}

/**
 * 一時ディレクトリを再帰削除するヘルパー
 */
function cleanupDir(dir: string): void {
  const parentDir = path.dirname(dir);
  if (parentDir.includes('aikata-git-diff-test-')) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * テスト用ゲートウェイ生成ヘルパー
 */
function createGateway(
  projectDir: string,
  fallbackGateway: Record<string, ReturnType<typeof vi.fn>>,
  client: Record<string, ReturnType<typeof vi.fn>>,
): LocalGitDiffMrGateway {
  return new LocalGitDiffMrGateway(
    projectDir,
    fallbackGateway as unknown as MrGateway,
    client as unknown as GitLabApiClient,
  );
}

describe('LocalGitDiffMrGateway', () => {
  let mockFallbackGateway: {
    getMrContext: ReturnType<typeof vi.fn>;
    getCommitsSince: ReturnType<typeof vi.fn>;
    getDiffSince: ReturnType<typeof vi.fn>;
  };
  let mockClient: {
    get: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetLogger();
    initializeLogger({ userId: 'test-user', level: 'silent' });
    mockFallbackGateway = {
      getMrContext: vi.fn(),
      getCommitsSince: vi.fn(),
      getDiffSince: vi.fn(),
    };
    mockClient = {
      get: vi.fn(),
      getAll: vi.fn(),
      post: vi.fn(),
    };
  });

  afterEach(() => {
    resetLogger();
  });

  describe('getMrContext', () => {
    it('ローカルgit diffが成功する場合、ローカルdiffが使用される', async () => {
      const repo = createTestRepoWithBranches();

      try {
        const apiMrContext = new MrContext({
          title: 'feat: test',
          description: 'test description',
          sourceBranch: 'feature/test',
          targetBranch: 'main',
          diff: 'api-diff-should-be-replaced',
          commitHash: repo.headCommitHash,
          commitMessage: 'add new file',
          baseSha: repo.baseCommitHash,
          headSha: repo.headCommitHash,
          startSha: repo.baseCommitHash,
        });
        mockFallbackGateway.getMrContext.mockResolvedValueOnce(apiMrContext);

        const gateway = createGateway(repo.workDir, mockFallbackGateway, mockClient);
        const result = await gateway.getMrContext('123', '42');

        // メタデータはAPIから取得される
        expect(result.title).toBe('feat: test');
        expect(result.description).toBe('test description');
        expect(result.sourceBranch).toBe('feature/test');
        expect(result.targetBranch).toBe('main');
        expect(result.commitHash).toBe(repo.headCommitHash);
        expect(result.commitMessage).toBe('add new file');

        // diffはローカルgitから取得される（APIのdiffではない）
        expect(result.diff).not.toBe('api-diff-should-be-replaced');
        expect(result.diff).toContain('new-file.ts');
        expect(result.diff).toContain('export const hello = "world"');

        // APIのaccess_raw_diffsは呼ばれない
        expect(mockClient.get).not.toHaveBeenCalled();
      } finally {
        cleanupDir(repo.workDir);
      }
    });

    it('ローカルgit diffが失敗し、API access_raw_diffs=trueが成功する場合', async () => {
      const nonExistentDir = '/tmp/aikata-non-existent-repo-dir';

      const apiMrContext = new MrContext({
        title: 'feat: test',
        description: 'test description',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        diff: 'api-diff-original',
        commitHash: 'abc123',
        commitMessage: 'add new file',
        baseSha: 'base-sha',
        headSha: 'head-sha',
        startSha: 'start-sha',
      });
      mockFallbackGateway.getMrContext.mockResolvedValueOnce(apiMrContext);

      // API access_raw_diffs=trueのレスポンス
      mockClient.get.mockResolvedValueOnce({
        changes: [
          {
            old_path: 'file.ts',
            new_path: 'file.ts',
            diff: '@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
      });

      const gateway = createGateway(nonExistentDir, mockFallbackGateway, mockClient);
      const result = await gateway.getMrContext('123', '42');

      // API access_raw_diffs=trueが呼ばれる
      expect(mockClient.get).toHaveBeenCalledWith(
        '/projects/123/merge_requests/42/changes?access_raw_diffs=true',
      );

      // diffはAPIのaccess_raw_diffsから取得される
      expect(result.diff).toContain('file.ts');
      expect(result.diff).toContain('-old');
      expect(result.diff).toContain('+new');
    });

    it('両方失敗する場合、エラーがスローされる', async () => {
      const nonExistentDir = '/tmp/aikata-non-existent-repo-dir';

      const apiMrContext = new MrContext({
        title: 'feat: test',
        description: 'test description',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        diff: 'api-diff-original',
        commitHash: 'abc123',
        commitMessage: 'add new file',
        baseSha: 'base-sha',
        headSha: 'head-sha',
        startSha: 'start-sha',
      });
      mockFallbackGateway.getMrContext.mockResolvedValueOnce(apiMrContext);

      // API access_raw_diffs=trueも失敗
      mockClient.get.mockRejectedValueOnce(new Error('API error'));

      const gateway = createGateway(nonExistentDir, mockFallbackGateway, mockClient);

      await expect(gateway.getMrContext('123', '42')).rejects.toThrow(
        'Failed to retrieve MR diff from both local git and API',
      );
    });

    it('MRメタデータはAPIから取得される', async () => {
      const repo = createTestRepoWithBranches();

      try {
        const apiMrContext = new MrContext({
          title: 'original title',
          description: 'original description',
          sourceBranch: 'feature/test',
          targetBranch: 'main',
          diff: 'api-diff',
          commitHash: repo.headCommitHash,
          commitMessage: 'original commit message',
          baseSha: repo.baseCommitHash,
          headSha: repo.headCommitHash,
          startSha: repo.baseCommitHash,
        });
        mockFallbackGateway.getMrContext.mockResolvedValueOnce(apiMrContext);

        const gateway = createGateway(repo.workDir, mockFallbackGateway, mockClient);
        const result = await gateway.getMrContext('123', '42');

        expect(result).toBeInstanceOf(MrContext);
        expect(result.title).toBe('original title');
        expect(result.description).toBe('original description');
        expect(result.commitHash).toBe(repo.headCommitHash);
        expect(result.commitMessage).toBe('original commit message');
      } finally {
        cleanupDir(repo.workDir);
      }
    });
  });

  describe('getDiffSince', () => {
    it('ローカルgit diffが成功する場合', async () => {
      const repo = createTestRepoWithBranches();

      try {
        const gateway = createGateway(repo.workDir, mockFallbackGateway, mockClient);
        const result = await gateway.getDiffSince(
          '123',
          '42',
          repo.baseCommitHash,
          repo.headCommitHash,
        );

        expect(result).toContain('new-file.ts');
        expect(result).toContain('export const hello = "world"');
        expect(mockFallbackGateway.getDiffSince).not.toHaveBeenCalled();
      } finally {
        cleanupDir(repo.workDir);
      }
    });

    it('ローカルgit diffが失敗し、フォールバックが成功する場合', async () => {
      const nonExistentDir = '/tmp/aikata-non-existent-repo-dir';
      mockFallbackGateway.getDiffSince.mockResolvedValueOnce('fallback-diff-content');

      const gateway = createGateway(nonExistentDir, mockFallbackGateway, mockClient);
      const result = await gateway.getDiffSince('123', '42', 'fromHash', 'toHash');

      expect(result).toBe('fallback-diff-content');
      expect(mockFallbackGateway.getDiffSince).toHaveBeenCalledWith(
        '123',
        '42',
        'fromHash',
        'toHash',
      );
    });

    it('両方失敗する場合、エラーがスローされる', async () => {
      const nonExistentDir = '/tmp/aikata-non-existent-repo-dir';
      mockFallbackGateway.getDiffSince.mockRejectedValueOnce(new Error('API error'));

      const gateway = createGateway(nonExistentDir, mockFallbackGateway, mockClient);

      await expect(gateway.getDiffSince('123', '42', 'fromHash', 'toHash')).rejects.toThrow(
        'API error',
      );
    });
  });

  describe('getCommitsSince', () => {
    it('fallbackGatewayにそのまま委譲される', async () => {
      const expectedCommits = ['commit message 1', 'commit message 2'];
      mockFallbackGateway.getCommitsSince.mockResolvedValueOnce(expectedCommits);

      const gateway = createGateway('/tmp/any-dir', mockFallbackGateway, mockClient);
      const result = await gateway.getCommitsSince('123', '42', 'sinceHash');

      expect(result).toEqual(expectedCommits);
      expect(mockFallbackGateway.getCommitsSince).toHaveBeenCalledWith('123', '42', 'sinceHash');
    });
  });
});
