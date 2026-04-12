import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineGateway } from '../../shared/port/gateway/PipelineGateway.js';
import type { Job } from '../../../domain/pipeline-report/job/Job.js';

/**
 * アーティファクトキャッシュエントリのステータス
 */
export type ArtifactCacheEntryStatus =
  | { kind: 'cached'; zipPath: string; bytes: number }
  | { kind: 'no-artifacts' }
  | { kind: 'skipped-too-large'; sizeBytes: number }
  | { kind: 'skipped-disk-full'; sizeBytes: number }
  | { kind: 'error'; reason: string };

/**
 * ArtifactCacheManagerのオプション
 */
export interface ArtifactCacheOptions {
  /** 単一ジョブのアーティファクトzipで許容する最大バイト数 */
  maxArtifactZipBytes: number;
  /** キャッシュ全体で許容する最大バイト数（累計ディスク使用量） */
  totalDiskBytes: number;
}

/**
 * ジョブのアーティファクトzipをローカルの一時ディレクトリにダウンロード・キャッシュするマネージャ。
 *
 * 責務:
 * - 1ジョブずつPipelineGatewayからzipをダウンロードして一時ディレクトリに保存する
 * - hasArtifacts=false / サイズ超過 / 累計ディスク超過 / エラー 等のケースをステータスとして記録
 * - ダウンロード済みのzipパスを問い合わせ可能
 * - cleanup()で一時ディレクトリごと削除
 */
export class ArtifactCacheManager {
  private tempDir: string | null = null;
  private totalBytes = 0;
  private readonly entries = new Map<number, ArtifactCacheEntryStatus>();

  constructor(
    private readonly gateway: PipelineGateway,
    private readonly options: ArtifactCacheOptions,
  ) {}

  /**
   * 指定ジョブ群のアーティファクトを一括プリフェッチする。
   * 各ジョブの結果はMapで返却される。
   */
  async prefetchForJobs(
    projectId: number,
    jobs: readonly Job[],
  ): Promise<Map<number, ArtifactCacheEntryStatus>> {
    // 既にprefetch済みの場合でも安全に動くよう、tempDirが無ければ作成する
    if (this.tempDir === null) {
      this.tempDir = await mkdtemp(join(tmpdir(), 'aikata-pipeline-report-'));
    }

    for (const job of jobs) {
      // アーティファクトが存在しない
      if (!job.hasArtifacts) {
        this.entries.set(job.id, { kind: 'no-artifacts' });
        continue;
      }
      // 単一ジョブのサイズ上限を超えている
      if (job.artifactsSize > this.options.maxArtifactZipBytes) {
        this.entries.set(job.id, {
          kind: 'skipped-too-large',
          sizeBytes: job.artifactsSize,
        });
        continue;
      }
      // 累計ディスク上限に達するとスキップ
      if (this.totalBytes + job.artifactsSize > this.options.totalDiskBytes) {
        this.entries.set(job.id, {
          kind: 'skipped-disk-full',
          sizeBytes: job.artifactsSize,
        });
        continue;
      }

      const zipPath = join(this.tempDir, `job-${job.id}.zip`);
      try {
        const result = await this.gateway.downloadArtifactArchive(projectId, job.id, zipPath, {
          maxBytes: this.options.maxArtifactZipBytes,
        });
        this.totalBytes += result.bytesWritten;
        this.entries.set(job.id, {
          kind: 'cached',
          zipPath,
          bytes: result.bytesWritten,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.entries.set(job.id, { kind: 'error', reason });
      }
    }

    return new Map(this.entries);
  }

  /**
   * キャッシュ済みジョブのzipパスを返す。未キャッシュ・エラー等の場合はnull。
   */
  getZipPath(jobId: number): string | null {
    const entry = this.entries.get(jobId);
    if (entry?.kind === 'cached') {
      return entry.zipPath;
    }
    return null;
  }

  /**
   * 全エントリのzipパス一覧を返す。cached以外はnullを値に持つ。
   */
  getCachePaths(): Map<number, string | null> {
    const result = new Map<number, string | null>();
    for (const [id, entry] of this.entries) {
      result.set(id, entry.kind === 'cached' ? entry.zipPath : null);
    }
    return result;
  }

  /**
   * 一時ディレクトリごと削除し、内部状態をリセットする。
   * 例外は投げず、best-effortで削除する。
   */
  async cleanup(): Promise<void> {
    if (this.tempDir !== null) {
      try {
        await rm(this.tempDir, { recursive: true, force: true });
      } catch {
        // クリーンアップ失敗はログ出力のみに委ねる（best-effort）
      }
      this.tempDir = null;
    }
    this.entries.clear();
    this.totalBytes = 0;
  }
}
