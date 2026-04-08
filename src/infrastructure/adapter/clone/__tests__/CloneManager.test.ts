import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile as realExecFile } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { CloneManager } from '../CloneManager.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';

// node:child_processをモック
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// node:fs/promisesをモック
vi.mock('node:fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// グローバルfetchをモック
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** du -sk の正常応答（上限以下） */
const DU_OK = { stdout: '100000\t/tmp/clone-dir' };

/**
 * execFileが呼び出し順に異なる結果を返すようにセットアップする
 * コールバック形式のexecFileをモックし、promisify経由でも動作する
 */
function setupExecFileSequence(responses: Array<{ stdout?: string; error?: Error }>): void {
  const mockedExecFile = vi.mocked(realExecFile);
  let callIndex = 0;
  type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
  mockedExecFile.mockImplementation(((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback?: ExecFileCallback,
  ) => {
    const response = responses[callIndex] || { stdout: '' };
    callIndex++;
    const cb = typeof _options === 'function' ? (_options as ExecFileCallback) : callback;
    if (cb) {
      if (response.error) {
        cb(response.error, '', response.error.message);
      } else {
        cb(null, response.stdout || '', '');
      }
    }
    return {} as ReturnType<typeof realExecFile>;
  }) as unknown as typeof realExecFile);
}

/**
 * GitLab APIのプロジェクト情報レスポンスのモックを作成する
 */
function mockGitLabProjectResponse(
  httpUrlToRepo = 'https://gitlab.example.com/group/project.git',
): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ http_url_to_repo: httpUrlToRepo }),
  });
}

/**
 * 正常なクローンフロー用のexecFileシーケンスをセットアップする
 * git clone → git fetch → git checkout → du -sk
 */
function setupNormalCloneSequence(): void {
  setupExecFileSequence([
    { stdout: '' }, // git clone
    { stdout: '' }, // git fetch
    { stdout: '' }, // git checkout
    DU_OK, // du -sk
  ]);
}

describe('CloneManager', () => {
  const defaultToken = 'test-token-123';
  const defaultApiBaseUrl = 'https://gitlab.example.com/api/v4';
  const defaultProjectId = '42';
  const defaultSourceBranch = 'feature/test';
  const defaultTargetBranch = 'main';

  beforeEach(() => {
    vi.clearAllMocks();
    resetLogger();
    initializeLogger({ userId: 'test-user', level: 'silent' });
  });

  afterEach(() => {
    resetLogger();
  });

  describe('clone', () => {
    it('正常系: リポジトリをクローンしCloneResultを返す', async () => {
      mockGitLabProjectResponse('https://gitlab.example.com/group/project.git');
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      const result = await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      // CloneResultの構造を検証
      expect(result.projectDir).toMatch(/^\/tmp\/aikata-test-clones\/clone-/);
      expect(result.sourceBranch).toBe(defaultSourceBranch);
      expect(result.targetBranch).toBe(defaultTargetBranch);
      expect(typeof result.cleanup).toBe('function');
    });

    it('正常系: GitLab APIからhttp_url_to_repoを取得してクローンURLを構築する', async () => {
      mockGitLabProjectResponse('https://gitlab.example.com/my-group/my-project.git');
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      // fetchがGitLab APIプロジェクトエンドポイントに対して呼ばれたことを確認
      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42',
        expect.objectContaining({
          headers: { 'PRIVATE-TOKEN': defaultToken },
        }),
      );

      // git cloneがトークン埋め込みURLで呼ばれたことを確認
      const mockedExecFile = vi.mocked(realExecFile);
      const cloneCall = mockedExecFile.mock.calls[0];
      expect(cloneCall[0]).toBe('git');
      const cloneArgs = cloneCall[1] as string[];
      expect(cloneArgs[0]).toBe('clone');
      expect(cloneArgs).toContain('--filter=blob:none');
      expect(cloneArgs).toContain('--no-checkout');
      // URLにトークンが埋め込まれていること
      const cloneUrl = cloneArgs.find((arg) => arg.includes('oauth2'));
      expect(cloneUrl).toBe(
        'https://oauth2:test-token-123@gitlab.example.com/my-group/my-project.git',
      );
    });

    it('正常系: git fetchでソースブランチとターゲットブランチを取得する', async () => {
      mockGitLabProjectResponse();
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      const mockedExecFile = vi.mocked(realExecFile);
      // 2番目の呼び出しがgit fetch
      const fetchCall = mockedExecFile.mock.calls[1];
      expect(fetchCall[0]).toBe('git');
      const fetchArgs = fetchCall[1] as string[];
      expect(fetchArgs[0]).toBe('fetch');
      expect(fetchArgs).toContain('origin');
      expect(fetchArgs).toContain(defaultSourceBranch);
      expect(fetchArgs).toContain(defaultTargetBranch);
    });

    it('正常系: git checkoutでソースブランチをチェックアウトする', async () => {
      mockGitLabProjectResponse();
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      const mockedExecFile = vi.mocked(realExecFile);
      // 3番目の呼び出しがgit checkout
      const checkoutCall = mockedExecFile.mock.calls[2];
      expect(checkoutCall[0]).toBe('git');
      const checkoutArgs = checkoutCall[1] as string[];
      expect(checkoutArgs[0]).toBe('checkout');
      expect(checkoutArgs).toContain(defaultSourceBranch);
    });

    it('正常系: 一時ディレクトリが作成される', async () => {
      mockGitLabProjectResponse();
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      // mkdirが呼ばれていること
      const mockedMkdir = vi.mocked(mkdir);
      expect(mockedMkdir).toHaveBeenCalledWith(
        expect.stringMatching(/^\/tmp\/aikata-test-clones\/clone-/),
        { recursive: true },
      );
    });

    it('異常系: GitLab APIエラー時にエラーがスローされる', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');

      await expect(
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          defaultSourceBranch,
          defaultTargetBranch,
        ),
      ).rejects.toThrow('Failed to fetch project info from GitLab API: 404 Not Found');
    });

    it('異常系: git clone失敗時にエラーがスローされクリーンアップされる', async () => {
      mockGitLabProjectResponse();
      setupExecFileSequence([{ error: new Error('clone failed: repository not found') }]);

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');

      await expect(
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          defaultSourceBranch,
          defaultTargetBranch,
        ),
      ).rejects.toThrow('clone failed: repository not found');

      // クリーンアップが実行されたことを確認
      const mockedRm = vi.mocked(rm);
      expect(mockedRm).toHaveBeenCalledWith(
        expect.stringMatching(/^\/tmp\/aikata-test-clones\/clone-/),
        { recursive: true, force: true },
      );
    });

    it('異常系: git fetch失敗時にエラーがスローされクリーンアップされる', async () => {
      mockGitLabProjectResponse();
      setupExecFileSequence([
        { stdout: '' }, // git clone 成功
        { error: new Error('fetch failed: branch not found') },
      ]);

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');

      await expect(
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          defaultSourceBranch,
          defaultTargetBranch,
        ),
      ).rejects.toThrow('fetch failed: branch not found');

      // クリーンアップが実行されたことを確認
      const mockedRm = vi.mocked(rm);
      expect(mockedRm).toHaveBeenCalledWith(
        expect.stringMatching(/^\/tmp\/aikata-test-clones\/clone-/),
        { recursive: true, force: true },
      );
    });
  });

  describe('cleanup', () => {
    it('正常系: cleanup関数が一時ディレクトリを削除する', async () => {
      mockGitLabProjectResponse();
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      const result = await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      // rmのモックをクリアして、cleanup呼び出しのrmだけを検証する
      vi.mocked(rm).mockClear();

      await result.cleanup();

      const mockedRm = vi.mocked(rm);
      expect(mockedRm).toHaveBeenCalledWith(result.projectDir, {
        recursive: true,
        force: true,
      });
    });
  });

  describe('セマフォ（同時実行制御）', () => {
    it('正常系: maxConcurrentClones以下の同時クローンは即座に実行される', async () => {
      const manager = new CloneManager(300_000, 1024, 2, '/tmp/aikata-test-clones');

      // 2つの同時クローンをセットアップ
      mockGitLabProjectResponse();
      mockGitLabProjectResponse();
      // 各cloneで4つのexecFile呼び出し（clone, fetch, checkout, du） x 2
      setupExecFileSequence([
        { stdout: '' },
        { stdout: '' },
        { stdout: '' },
        DU_OK,
        { stdout: '' },
        { stdout: '' },
        { stdout: '' },
        DU_OK,
      ]);

      // 2つ同時に開始（maxConcurrentClones=2なので両方即座に実行）
      const [result1, result2] = await Promise.all([
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          'branch1',
          defaultTargetBranch,
        ),
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          'branch2',
          defaultTargetBranch,
        ),
      ]);

      expect(result1.sourceBranch).toBe('branch1');
      expect(result2.sourceBranch).toBe('branch2');

      // クリーンアップ
      await result1.cleanup();
      await result2.cleanup();
    });

    it('正常系: maxConcurrentClonesを超える場合は待機し、空きが出たら実行される', async () => {
      const manager = new CloneManager(300_000, 1024, 1, '/tmp/aikata-test-clones');

      // 1つ目のクローン用
      mockGitLabProjectResponse();
      // 2つ目のクローン用
      mockGitLabProjectResponse();

      // execFileの呼び出し: 各cloneで4回 x 2
      setupExecFileSequence([
        { stdout: '' },
        { stdout: '' },
        { stdout: '' },
        DU_OK,
        { stdout: '' },
        { stdout: '' },
        { stdout: '' },
        DU_OK,
      ]);

      // maxConcurrentClones=1なので、1つ目が完了するまで2つ目は待機
      const result1 = await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        'branch1',
        defaultTargetBranch,
      );

      // 1つ目のcleanupでセマフォを解放
      await result1.cleanup();

      // 2つ目が実行可能になる
      const result2 = await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        'branch2',
        defaultTargetBranch,
      );

      expect(result2.sourceBranch).toBe('branch2');
      await result2.cleanup();
    });

    it('異常系: セマフォ取得がタイムアウトした場合にエラーがスローされる', async () => {
      // maxConcurrentClones=1, semaphoreTimeoutMs=100（短いタイムアウト）
      const manager = new CloneManager(300_000, 1024, 1, '/tmp/aikata-test-clones', 100);

      // 1つ目のクローン用
      mockGitLabProjectResponse();
      setupExecFileSequence([{ stdout: '' }, { stdout: '' }, { stdout: '' }, DU_OK]);

      // 1つ目のクローンでセマフォを占有
      const result1 = await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        'branch1',
        defaultTargetBranch,
      );

      // 2つ目はセマフォ待機でタイムアウトする（cleanupしないのでスロットが空かない）
      // セマフォ取得前にタイムアウトするため、fetchモックやexecFileモックは不要
      await expect(
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          'branch2',
          defaultTargetBranch,
        ),
      ).rejects.toThrow('Clone semaphore timeout: all slots occupied');

      // 1つ目のクリーンアップ
      await result1.cleanup();
    });

    it('正常系: エラー時にもセマフォが解放される', async () => {
      const manager = new CloneManager(300_000, 1024, 1, '/tmp/aikata-test-clones');

      // 1つ目は失敗（GitLab API 500エラー）
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // 1つ目が失敗
      await expect(
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          'branch1',
          defaultTargetBranch,
        ),
      ).rejects.toThrow();

      // 2つ目は成功
      mockGitLabProjectResponse();
      setupExecFileSequence([{ stdout: '' }, { stdout: '' }, { stdout: '' }, DU_OK]);

      // セマフォが解放されているので2つ目が実行可能
      const result2 = await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        'branch2',
        defaultTargetBranch,
      );

      expect(result2.sourceBranch).toBe('branch2');
      await result2.cleanup();
    });
  });

  describe('クローンURL構築', () => {
    it('正常系: http_url_to_repoにトークンを埋め込んだURLを生成する', async () => {
      mockGitLabProjectResponse('https://gitlab.example.com/nested/group/project.git');
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      await manager.clone(
        'my-secret-token',
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      const mockedExecFile = vi.mocked(realExecFile);
      const cloneCall = mockedExecFile.mock.calls[0];
      const cloneArgs = cloneCall[1] as string[];
      const cloneUrl = cloneArgs.find((arg) => arg.includes('oauth2'));
      expect(cloneUrl).toBe(
        'https://oauth2:my-secret-token@gitlab.example.com/nested/group/project.git',
      );
    });

    it('正常系: HTTPのURLも正しく処理する', async () => {
      mockGitLabProjectResponse('http://gitlab.local/group/project.git');
      setupNormalCloneSequence();

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      await manager.clone(
        defaultToken,
        'http://gitlab.local/api/v4',
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      const mockedExecFile = vi.mocked(realExecFile);
      const cloneCall = mockedExecFile.mock.calls[0];
      const cloneArgs = cloneCall[1] as string[];
      const cloneUrl = cloneArgs.find((arg) => arg.includes('oauth2'));
      expect(cloneUrl).toBe('http://oauth2:test-token-123@gitlab.local/group/project.git');
    });
  });

  describe('ディスクサイズチェック', () => {
    it('異常系: クローン後のディスク使用量が上限を超えた場合エラーがスローされる', async () => {
      mockGitLabProjectResponse();

      // git clone, fetch, checkout成功、du -skで上限超過
      setupExecFileSequence([
        { stdout: '' }, // git clone
        { stdout: '' }, // git fetch
        { stdout: '' }, // git checkout
        { stdout: '2000000\t/tmp/clone-dir' }, // du -sk: ~1953MB > 1024MB上限
      ]);

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');

      await expect(
        manager.clone(
          defaultToken,
          defaultApiBaseUrl,
          defaultProjectId,
          defaultSourceBranch,
          defaultTargetBranch,
        ),
      ).rejects.toThrow('Clone disk usage exceeds limit');

      // クリーンアップが実行されたことを確認
      const mockedRm = vi.mocked(rm);
      expect(mockedRm).toHaveBeenCalled();
    });

    it('正常系: ディスク使用量が上限以下の場合は正常に完了する', async () => {
      mockGitLabProjectResponse();

      setupExecFileSequence([
        { stdout: '' }, // git clone
        { stdout: '' }, // git fetch
        { stdout: '' }, // git checkout
        { stdout: '500000\t/tmp/clone-dir' }, // du -sk: ~488MB < 1024MB上限
      ]);

      const manager = new CloneManager(300_000, 1024, 5, '/tmp/aikata-test-clones');
      const result = await manager.clone(
        defaultToken,
        defaultApiBaseUrl,
        defaultProjectId,
        defaultSourceBranch,
        defaultTargetBranch,
      );

      expect(result.projectDir).toBeDefined();
      await result.cleanup();
    });
  });
});
