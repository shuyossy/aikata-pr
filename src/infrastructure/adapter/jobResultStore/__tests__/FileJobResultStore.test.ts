import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileJobResultStore } from '../FileJobResultStore.js';
import type {
  JobResultRecord,
  PendingJobResultRecord,
  SuccessJobResultRecord,
  FailedJobResultRecord,
} from '../../../../application/shared/port/jobResultStore/index.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';

const NOW = new Date('2026-04-29T00:00:00.000Z');
const FUTURE = new Date('2026-04-30T00:00:00.000Z');
const PAST = new Date('2026-04-28T00:00:00.000Z');

function makePending(overrides: Partial<PendingJobResultRecord> = {}): PendingJobResultRecord {
  return {
    jobId: overrides.jobId ?? randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    feature: overrides.feature ?? 'review',
    status: 'pending',
    userId: overrides.userId ?? 'user-1',
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    updatedAt: overrides.updatedAt ?? NOW.toISOString(),
    expiresAt: overrides.expiresAt ?? FUTURE.toISOString(),
  };
}

function makeSuccess(overrides: Partial<SuccessJobResultRecord> = {}): SuccessJobResultRecord {
  return {
    jobId: overrides.jobId ?? randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    feature: overrides.feature ?? 'review',
    status: 'success',
    userId: overrides.userId ?? 'user-1',
    payload: overrides.payload ?? { ok: true },
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    updatedAt: overrides.updatedAt ?? NOW.toISOString(),
    expiresAt: overrides.expiresAt ?? FUTURE.toISOString(),
  };
}

function makeFailed(overrides: Partial<FailedJobResultRecord> = {}): FailedJobResultRecord {
  return {
    jobId: overrides.jobId ?? randomUUID(),
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    feature: overrides.feature ?? 'review',
    status: 'failed',
    userId: overrides.userId ?? 'user-1',
    errorMessage: overrides.errorMessage ?? 'something went wrong',
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    updatedAt: overrides.updatedAt ?? NOW.toISOString(),
    expiresAt: overrides.expiresAt ?? FUTURE.toISOString(),
  };
}

describe('FileJobResultStore', () => {
  let baseDir: string;
  let store: FileJobResultStore;

  beforeEach(async () => {
    resetLogger();
    initializeLogger({ userId: 'test-user', level: 'silent' });
    baseDir = join(tmpdir(), `aikata-test-jobs-${randomUUID()}`);
    store = new FileJobResultStore(baseDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    resetLogger();
  });

  describe('save / load', () => {
    it('pendingレコードを保存して読み出せること', async () => {
      const record = makePending();
      await store.save(record);
      const loaded = await store.load(record.jobId);
      expect(loaded).toEqual(record);
    });

    it('successレコードを保存して読み出せること（payload含む）', async () => {
      const record = makeSuccess({ payload: { results: [{ id: 1, ok: true }] } });
      await store.save(record);
      const loaded = await store.load(record.jobId);
      expect(loaded).toEqual(record);
    });

    it('failedレコードを保存して読み出せること（errorMessage含む）', async () => {
      const record = makeFailed({ errorMessage: 'AI workflow failed' });
      await store.save(record);
      const loaded = await store.load(record.jobId);
      expect(loaded).toEqual(record);
    });

    it('存在しないjobIdを読み出すとnullを返すこと', async () => {
      const result = await store.load('nonexistent-job-id');
      expect(result).toBeNull();
    });

    it('同じjobIdで上書き保存できること（pending → success）', async () => {
      const pending = makePending();
      await store.save(pending);
      const success = makeSuccess({
        jobId: pending.jobId,
        idempotencyKey: pending.idempotencyKey,
        feature: pending.feature,
        userId: pending.userId,
        createdAt: pending.createdAt,
        updatedAt: FUTURE.toISOString(),
        expiresAt: pending.expiresAt,
        payload: { result: 'ok' },
      });
      await store.save(success);
      const loaded = await store.load(pending.jobId);
      expect(loaded).toEqual(success);
    });
  });

  describe('loadByIdempotencyKey', () => {
    it('保存後、Idempotency-Keyで取得できること', async () => {
      const record = makeSuccess();
      await store.save(record);
      const loaded = await store.loadByIdempotencyKey(record.idempotencyKey);
      expect(loaded).toEqual(record);
    });

    it('存在しないキーではnullを返すこと', async () => {
      const result = await store.loadByIdempotencyKey('nonexistent-key');
      expect(result).toBeNull();
    });

    it('上書き保存後も同じIdempotency-Keyで最新を取得できること', async () => {
      const pending = makePending();
      await store.save(pending);
      const success = makeSuccess({
        jobId: pending.jobId,
        idempotencyKey: pending.idempotencyKey,
        feature: pending.feature,
        userId: pending.userId,
        createdAt: pending.createdAt,
        updatedAt: FUTURE.toISOString(),
        expiresAt: pending.expiresAt,
        payload: { result: 'updated' },
      });
      await store.save(success);
      const loaded = await store.loadByIdempotencyKey(pending.idempotencyKey);
      expect(loaded).toEqual(success);
    });

    it('索引のみ残ってレコード本体が消えている場合はnullを返すこと', async () => {
      const record = makeSuccess();
      await store.save(record);
      // レコード本体だけ削除して索引を残す
      await rm(join(baseDir, `${record.jobId}.json`));
      const loaded = await store.loadByIdempotencyKey(record.idempotencyKey);
      expect(loaded).toBeNull();
    });
  });

  describe('sweepExpired', () => {
    it('expiresAtが過去のレコードを削除すること', async () => {
      const expired = makeSuccess({ expiresAt: PAST.toISOString() });
      const fresh = makeSuccess({ expiresAt: FUTURE.toISOString() });
      await store.save(expired);
      await store.save(fresh);

      const removed = await store.sweepExpired(NOW);

      expect(removed).toBe(1);
      expect(await store.load(expired.jobId)).toBeNull();
      expect(await store.load(fresh.jobId)).not.toBeNull();
    });

    it('期限切れレコードに対応するIdempotency-Key索引も削除すること', async () => {
      const expired = makeSuccess({ expiresAt: PAST.toISOString() });
      await store.save(expired);

      await store.sweepExpired(NOW);

      const result = await store.loadByIdempotencyKey(expired.idempotencyKey);
      expect(result).toBeNull();
    });

    it('期限切れがない場合は0を返すこと', async () => {
      await store.save(makeSuccess({ expiresAt: FUTURE.toISOString() }));
      const removed = await store.sweepExpired(NOW);
      expect(removed).toBe(0);
    });
  });

  describe('init / cleanup', () => {
    it('init後にbaseDirと.idempotencyサブディレクトリが存在すること', async () => {
      const baseStat = await stat(baseDir);
      expect(baseStat.isDirectory()).toBe(true);
      const indexStat = await stat(join(baseDir, '.idempotency'));
      expect(indexStat.isDirectory()).toBe(true);
    });

    it('init時に.lockディレクトリ残骸を削除すること', async () => {
      // 既存ストアを破棄
      await rm(baseDir, { recursive: true, force: true });
      // baseDirを再作成しlock残骸を配置
      await mkdir(baseDir, { recursive: true });
      const lockPath = join(baseDir, 'old-job.json.lock');
      await mkdir(lockPath);

      const newStore = new FileJobResultStore(baseDir);
      await newStore.init();

      const entries = await readdir(baseDir);
      expect(entries.filter((e) => e.endsWith('.lock'))).toEqual([]);
    });

    it('init時に孤児になった索引（参照先が存在しないもの）を削除すること', async () => {
      // 索引だけを作成して本体は作らない
      const orphanKey = randomUUID();
      await writeFile(join(baseDir, '.idempotency', orphanKey), 'nonexistent-job-id', 'utf-8');

      // 別のストアインスタンスで再 init
      const newStore = new FileJobResultStore(baseDir);
      await newStore.init();

      const result = await newStore.loadByIdempotencyKey(orphanKey);
      expect(result).toBeNull();
      const entries = await readdir(join(baseDir, '.idempotency'));
      expect(entries).not.toContain(orphanKey);
    });
  });

  describe('並行制御', () => {
    it('同じjobIdに対する並行save呼び出しがロックで直列化されること（最後の書き込みが残る）', async () => {
      const baseRecord = makePending();
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        const success: SuccessJobResultRecord = {
          jobId: baseRecord.jobId,
          idempotencyKey: baseRecord.idempotencyKey,
          feature: baseRecord.feature,
          userId: baseRecord.userId,
          createdAt: baseRecord.createdAt,
          updatedAt: new Date(NOW.getTime() + i).toISOString(),
          expiresAt: baseRecord.expiresAt,
          status: 'success',
          payload: { iteration: i },
        };
        promises.push(store.save(success));
      }
      await Promise.all(promises);

      const loaded = (await store.load(baseRecord.jobId)) as SuccessJobResultRecord | null;
      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe('success');
      // payload が壊れていない（途中切断・部分書き込みでない）こと
      expect((loaded!.payload as { iteration: number }).iteration).toBeGreaterThanOrEqual(0);
      expect((loaded!.payload as { iteration: number }).iteration).toBeLessThan(10);
    });
  });

  describe('レコード形式の検証', () => {
    it('保存されたファイルが有効なJSONであること（破損していないこと）', async () => {
      const record = makeSuccess({ payload: { complex: { nested: [1, 2, 3] } } });
      await store.save(record);

      const filePath = join(baseDir, `${record.jobId}.json`);
      const fileStat = await stat(filePath);
      expect(fileStat.isFile()).toBe(true);

      const loaded = await store.load(record.jobId);
      expect(loaded).toEqual(record);
    });

    it('Idempotency-Key索引の内容がjobIdを指すこと', async () => {
      const record = makeSuccess();
      await store.save(record);
      // 索引ファイルを直接読み込み、内容がjobIdであることを確認
      const indexPath = join(baseDir, '.idempotency', record.idempotencyKey);
      const indexStat = await stat(indexPath);
      expect(indexStat.isFile()).toBe(true);
    });
  });

  describe('jobIdの形式バリデーション', () => {
    it('jobId / idempotencyKeyにパス区切り文字が含まれていたら拒否すること', async () => {
      const malicious: JobResultRecord = makePending({ jobId: '../etc/passwd' });
      await expect(store.save(malicious)).rejects.toThrow();
    });

    it('idempotencyKeyにパス区切り文字が含まれていたら拒否すること', async () => {
      const malicious: JobResultRecord = makePending({
        idempotencyKey: '../escape',
      });
      await expect(store.save(malicious)).rejects.toThrow();
    });

    it('loadのjobIdにパス区切り文字が含まれていたら拒否すること', async () => {
      await expect(store.load('../escape')).rejects.toThrow();
    });

    it('loadByIdempotencyKeyのキーにパス区切り文字が含まれていたら拒否すること', async () => {
      await expect(store.loadByIdempotencyKey('../escape')).rejects.toThrow();
    });
  });
});
