import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CloneManagerPort,
  CloneResult,
} from '../../../application/shared/port/clone/index.js';
import { getLogger } from '../../../lib/logger.js';

/**
 * execFileをPromiseでラップするヘルパー
 * Node.jsのcustom promisify動作（{ stdout, stderr }を返す）を再現する
 */
function execFileAsync(
  file: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options as Parameters<typeof execFile>[2], (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
  });
}

/**
 * GitLab APIから返却されるプロジェクト情報の型定義
 */
interface GitLabProjectInfo {
  http_url_to_repo: string;
}

/**
 * execFileAsyncの共通オプション
 */
const GIT_EXEC_OPTIONS = {
  encoding: 'utf-8' as const,
  maxBuffer: 50 * 1024 * 1024,
};

/**
 * リポジトリのクローン管理を行う実装クラス
 * APIリクエストごとにリポジトリをクローンし、処理後にクリーンアップする
 *
 * - セマフォによる同時実行数制御
 * - タイムアウト制御
 * - ディスク使用量チェック
 * - 失敗時の自動クリーンアップ
 */
export class CloneManager implements CloneManagerPort {
  /** 現在のクローン数 */
  private currentClones = 0;
  /** セマフォ待機キュー */
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(
    private readonly cloneTimeoutMs: number = 300_000,
    private readonly maxDiskMb: number = 1024,
    private readonly maxConcurrentClones: number = 5,
    private readonly baseTmpDir: string = '/tmp/aikata-pr-clones',
    private readonly semaphoreTimeoutMs: number = 600_000,
  ) {}

  /**
   * リポジトリをクローンし、MR関連ブランチを取得する
   *
   * 1. セマフォ取得（同時実行数制御）
   * 2. GitLab APIからプロジェクト情報を取得しクローンURLを構築
   * 3. git clone --filter=blob:none --no-checkout
   * 4. git fetch origin <sourceBranch> <targetBranch>
   * 5. git checkout <sourceBranch>
   * 6. ディスク使用量チェック
   * 7. CloneResultを返却
   */
  async clone(
    gitlabToken: string,
    gitlabApiBaseUrl: string,
    projectId: string,
    sourceBranch: string,
    targetBranch: string,
    commitSha: string | null,
  ): Promise<CloneResult> {
    // セマフォ取得（空くまで待機）
    await this.acquireSemaphore();

    const tmpDir = join(this.baseTmpDir, `clone-${randomUUID()}`);

    try {
      // 一時ディレクトリを作成
      await mkdir(tmpDir, { recursive: true });

      // GitLab APIからプロジェクト情報を取得
      const cloneUrl = await this.buildCloneUrl(gitlabToken, gitlabApiBaseUrl, projectId);
      getLogger().info({ projectId }, 'Clone URL constructed for project');

      // git clone --filter=blob:none --no-checkout
      await execFileAsync(
        'git',
        ['clone', '--filter=blob:none', '--no-checkout', cloneUrl, tmpDir],
        {
          ...GIT_EXEC_OPTIONS,
          timeout: this.cloneTimeoutMs,
        },
      );
      getLogger().info({ projectId, tmpDir }, 'Repository cloned successfully');

      // git fetch origin <sourceBranch> <targetBranch>
      await execFileAsync('git', ['fetch', 'origin', sourceBranch, targetBranch], {
        ...GIT_EXEC_OPTIONS,
        cwd: tmpDir,
        timeout: this.cloneTimeoutMs,
      });
      getLogger().info({ sourceBranch, targetBranch }, 'Branches fetched successfully');

      // git checkout <sourceBranch>
      await execFileAsync('git', ['checkout', sourceBranch], {
        ...GIT_EXEC_OPTIONS,
        cwd: tmpDir,
        timeout: this.cloneTimeoutMs,
      });
      getLogger().info({ sourceBranch }, 'Source branch checked out');

      // commitSha が指定されている場合、特定のコミットをcheckout（detached HEAD）
      if (commitSha) {
        await execFileAsync('git', ['checkout', commitSha], {
          ...GIT_EXEC_OPTIONS,
          cwd: tmpDir,
          timeout: this.cloneTimeoutMs,
        });
        getLogger().info({ commitSha }, 'Specific commit checked out');
      }

      // ディスク使用量チェック
      await this.checkDiskUsage(tmpDir);

      return {
        projectDir: tmpDir,
        sourceBranch,
        targetBranch,
        cleanup: async () => {
          await rm(tmpDir, { recursive: true, force: true });
          this.releaseSemaphore();
        },
      };
    } catch (error) {
      // エラー時のクリーンアップ
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      this.releaseSemaphore();
      throw error;
    }
  }

  /**
   * GitLab APIからプロジェクト情報を取得し、トークン埋め込みクローンURLを構築する
   */
  private async buildCloneUrl(
    gitlabToken: string,
    gitlabApiBaseUrl: string,
    projectId: string,
  ): Promise<string> {
    // 末尾スラッシュを除去して正規化
    const normalizedBaseUrl = gitlabApiBaseUrl.replace(/\/$/, '');

    const response = await fetch(`${normalizedBaseUrl}/projects/${projectId}`, {
      headers: { 'PRIVATE-TOKEN': gitlabToken },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch project info from GitLab API: ${response.status} ${response.statusText}`,
      );
    }

    const projectInfo = (await response.json()) as GitLabProjectInfo;
    const httpUrlToRepo = projectInfo.http_url_to_repo;

    // http(s)://host/path.git → http(s)://oauth2:<token>@host/path.git
    const url = new URL(httpUrlToRepo);
    url.username = 'oauth2';
    url.password = gitlabToken;

    return url.toString();
  }

  /**
   * クローンされたリポジトリのディスク使用量をチェックする
   * 上限を超えている場合はエラーをスローする
   */
  private async checkDiskUsage(dir: string): Promise<void> {
    const { stdout } = await execFileAsync('du', ['-sk', dir], {
      encoding: 'utf-8',
    });

    // du -sk の出力: "12345\t/path/to/dir"
    const sizeKb = parseInt(stdout.split('\t')[0], 10);
    const sizeMb = sizeKb / 1024;

    if (sizeMb > this.maxDiskMb) {
      throw new Error(
        `Clone disk usage exceeds limit: ${Math.round(sizeMb)}MB > ${this.maxDiskMb}MB`,
      );
    }

    getLogger().info(
      { sizeMb: Math.round(sizeMb), maxDiskMb: this.maxDiskMb },
      'Disk usage check passed',
    );
  }

  /**
   * セマフォを取得する（同時実行数制御）
   * 現在のクローン数が上限に達している場合は、空きが出るまで待機する
   * タイムアウト（semaphoreTimeoutMs）を超えた場合はエラーをスローする
   */
  private async acquireSemaphore(): Promise<void> {
    if (this.currentClones < this.maxConcurrentClones) {
      this.currentClones++;
      return;
    }

    // 上限に達している場合は待機キューに追加（タイムアウト付き）
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.waitQueue.push(entry);

      const timer = setTimeout(() => {
        // タイムアウト時: 待機キューからエントリを削除しエラーで拒否
        const index = this.waitQueue.indexOf(entry);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
          reject(new Error('Clone semaphore timeout: all slots occupied'));
        }
      }, this.semaphoreTimeoutMs);

      // 元のresolve/rejectをラップしてタイマーをクリアする
      const originalResolve = entry.resolve;
      const originalReject = entry.reject;
      entry.resolve = () => {
        clearTimeout(timer);
        originalResolve();
      };
      entry.reject = (err: Error) => {
        clearTimeout(timer);
        originalReject(err);
      };
    });
  }

  /**
   * セマフォを解放する
   * 待機キューにエントリがあれば次のクローンを開始する
   */
  private releaseSemaphore(): void {
    if (this.waitQueue.length > 0) {
      // 待機中のクローンがあれば解放（currentClonesはそのまま）
      const next = this.waitQueue.shift()!;
      next.resolve();
    } else {
      this.currentClones--;
    }
  }
}
