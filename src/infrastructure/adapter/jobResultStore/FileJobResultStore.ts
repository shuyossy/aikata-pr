import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  JobResultRecord,
  JobResultStore,
} from '../../../application/shared/port/jobResultStore/index.js';
import { getLogger } from '../../../lib/logger.js';

const INDEX_DIR_NAME = '.idempotency';
const RECORD_EXT = '.json';
const TMP_EXT = '.tmp';
const LOCK_EXT = '.lock';

/**
 * ファイル名にパス区切り文字や `..` などを含む値を許可しないバリデーション
 * jobId / idempotencyKey は本来 UUID v4 だが、防御的にチェックする
 */
function ensureSafeIdentifier(value: string, kind: string): void {
  if (!value || value.length === 0) {
    throw new Error(`${kind} must be non-empty`);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('..') || value.includes(sep)) {
    throw new Error(`${kind} contains path-traversal characters: ${value}`);
  }
}

/**
 * ファイル単位のmkdirロックを取得する
 *
 * `mkdir(lockPath)` はディレクトリが既存ならEEXISTで失敗する原子操作なので
 * これを利用して排他制御を行う。
 */
async function acquireLock(lockPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lockPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      await sleep(20);
    }
  }
  throw new Error(`Failed to acquire job result store lock within ${timeoutMs}ms: ${lockPath}`);
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
}

/**
 * ファイルベースのJobResultStore実装
 *
 * - レコード本体: `<baseDir>/<jobId>.json`
 * - Idempotency-Key索引: `<baseDir>/.idempotency/<idempotencyKey>` （内容: jobId）
 * - 排他制御: `<baseDir>/<jobId>.json.lock` (mkdir原子操作)
 * - atomic write: `<baseDir>/<jobId>.json.tmp` を書き込んで `rename`
 */
export class FileJobResultStore implements JobResultStore {
  constructor(
    private readonly baseDir: string,
    private readonly lockTimeoutMs: number = 5_000,
  ) {}

  /**
   * ストア初期化（起動時に1回呼ぶ）
   * - baseDir/.idempotency 作成
   * - 残骸の *.lock ディレクトリ削除
   * - 孤児索引（参照先がないもの）削除
   */
  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await mkdir(join(this.baseDir, INDEX_DIR_NAME), { recursive: true });

    await this.cleanupStaleLocks();
    await this.cleanupOrphanIndexes();
  }

  async save(record: JobResultRecord): Promise<void> {
    ensureSafeIdentifier(record.jobId, 'jobId');
    ensureSafeIdentifier(record.idempotencyKey, 'idempotencyKey');

    const recordPath = this.recordPath(record.jobId);
    const tmpPath = `${recordPath}${TMP_EXT}`;
    const lockPath = `${recordPath}${LOCK_EXT}`;

    await acquireLock(lockPath, this.lockTimeoutMs);
    try {
      // レコード本体を atomic write
      await writeFile(tmpPath, JSON.stringify(record), 'utf-8');
      await rename(tmpPath, recordPath);

      // Idempotency-Key索引を atomic write（毎回上書き、内容は jobId）
      const indexPath = this.indexPath(record.idempotencyKey);
      const indexTmpPath = `${indexPath}${TMP_EXT}`;
      await writeFile(indexTmpPath, record.jobId, 'utf-8');
      await rename(indexTmpPath, indexPath);
    } finally {
      await releaseLock(lockPath);
    }
  }

  async load(jobId: string): Promise<JobResultRecord | null> {
    ensureSafeIdentifier(jobId, 'jobId');
    try {
      const content = await readFile(this.recordPath(jobId), 'utf-8');
      return JSON.parse(content) as JobResultRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async loadByIdempotencyKey(key: string): Promise<JobResultRecord | null> {
    ensureSafeIdentifier(key, 'idempotencyKey');
    let jobId: string;
    try {
      jobId = (await readFile(this.indexPath(key), 'utf-8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
    if (jobId.length === 0) {
      return null;
    }
    return this.load(jobId);
  }

  async sweepExpired(now: Date): Promise<number> {
    const entries = await readdir(this.baseDir);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith(RECORD_EXT) || entry.endsWith(TMP_EXT)) continue;
      const recordPath = join(this.baseDir, entry);
      try {
        const content = await readFile(recordPath, 'utf-8');
        const record = JSON.parse(content) as JobResultRecord;
        const expiresAt = new Date(record.expiresAt).getTime();
        if (Number.isFinite(expiresAt) && expiresAt < now.getTime()) {
          await rm(recordPath, { force: true });
          await rm(this.indexPath(record.idempotencyKey), { force: true });
          removed++;
        }
      } catch (err) {
        getLogger().warn(
          { err, recordPath },
          'Failed to inspect job result record during sweep; skipping',
        );
      }
    }
    return removed;
  }

  /**
   * baseDir直下に残った `*.lock` ディレクトリを削除する
   * （クラッシュ等で残骸となったロックを起動時にクリーンアップ）
   */
  private async cleanupStaleLocks(): Promise<void> {
    const entries = await readdir(this.baseDir);
    for (const entry of entries) {
      if (entry.endsWith(LOCK_EXT)) {
        await rm(join(this.baseDir, entry), { recursive: true, force: true });
      }
    }
  }

  /**
   * 索引ディレクトリ内の参照先（jobId）が存在しないエントリを削除する
   */
  private async cleanupOrphanIndexes(): Promise<void> {
    const indexDir = join(this.baseDir, INDEX_DIR_NAME);
    const entries = await readdir(indexDir);
    for (const entry of entries) {
      const indexFilePath = join(indexDir, entry);
      try {
        const jobId = (await readFile(indexFilePath, 'utf-8')).trim();
        if (jobId.length === 0) {
          await rm(indexFilePath, { force: true });
          continue;
        }
        try {
          await stat(this.recordPath(jobId));
        } catch (statErr) {
          if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
            await rm(indexFilePath, { force: true });
          }
        }
      } catch (err) {
        getLogger().warn(
          { err, indexFilePath },
          'Failed to inspect idempotency index during cleanup; skipping',
        );
      }
    }
  }

  private recordPath(jobId: string): string {
    return join(this.baseDir, `${jobId}${RECORD_EXT}`);
  }

  private indexPath(key: string): string {
    return join(this.baseDir, INDEX_DIR_NAME, key);
  }
}
