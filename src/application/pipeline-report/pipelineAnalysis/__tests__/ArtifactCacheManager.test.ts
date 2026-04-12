import { describe, it, expect, beforeEach } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import { ArtifactCacheManager } from '../ArtifactCacheManager.js';
import { Job } from '../../../../domain/pipeline-report/job/Job.js';
import type { PipelineGateway } from '../../../shared/port/gateway/PipelineGateway.js';
import type { Pipeline } from '../../../../domain/pipeline-report/pipeline/Pipeline.js';

// テスト用のJobファクトリ
const makeJob = (params: { id: number; hasArtifacts: boolean; artifactsSize: number }): Job =>
  Job.of({
    id: params.id,
    name: `job-${params.id}`,
    stage: 'test',
    status: 'success',
    startedAt: null,
    finishedAt: null,
    duration: null,
    webUrl: `https://example.com/jobs/${params.id}`,
    failureReason: null,
    hasArtifacts: params.hasArtifacts,
    artifactsSize: params.artifactsSize,
  });

// テスト用のfake PipelineGateway
// downloadArtifactArchive以外のメソッドは使わない前提で雑にスタブ
class FakePipelineGateway implements PipelineGateway {
  // 呼び出し記録
  public calls: Array<{
    projectId: number;
    jobId: number;
    destPath: string;
    maxBytes: number;
  }> = [];

  constructor(
    private readonly behavior: {
      // ダウンロードされたファイルに書き込むバイト数
      writtenBytes: number;
      // ダウンロード結果のbytesWritten（writtenBytesと別にしたい場合用）
      reportedBytes?: number;
      // trueならダウンロード時にエラーを投げる
      shouldThrow?: boolean;
    },
  ) {}

  async getPipeline(): Promise<Pipeline> {
    throw new Error('not implemented for this test');
  }

  async getJobs(): Promise<Job[]> {
    throw new Error('not implemented for this test');
  }

  async getJobTrace(): Promise<string> {
    throw new Error('not implemented for this test');
  }

  async getMergedYaml(): Promise<string | null> {
    throw new Error('not implemented for this test');
  }

  async downloadArtifactArchive(
    projectId: number,
    jobId: number,
    destPath: string,
    options: { maxBytes: number },
  ): Promise<{ bytesWritten: number; truncated: boolean }> {
    this.calls.push({ projectId, jobId, destPath, maxBytes: options.maxBytes });
    if (this.behavior.shouldThrow) {
      throw new Error(`simulated download failure for job ${jobId}`);
    }
    // 実際にダミーファイルを書き込んでおく
    await writeFile(destPath, Buffer.alloc(this.behavior.writtenBytes));
    return {
      bytesWritten: this.behavior.reportedBytes ?? this.behavior.writtenBytes,
      truncated: false,
    };
  }
}

describe('ArtifactCacheManager', () => {
  let gateway: FakePipelineGateway;

  beforeEach(() => {
    gateway = new FakePipelineGateway({ writtenBytes: 100 });
  });

  it('hasArtifacts=falseのジョブはno-artifactsとしてスキップする', async () => {
    const manager = new ArtifactCacheManager(gateway, {
      maxArtifactZipBytes: 1000,
      totalDiskBytes: 10000,
    });
    const jobs = [makeJob({ id: 1, hasArtifacts: false, artifactsSize: 0 })];

    const result = await manager.prefetchForJobs(42, jobs);

    expect(result.get(1)).toEqual({ kind: 'no-artifacts' });
    expect(gateway.calls.length).toBe(0);
    await manager.cleanup();
  });

  it('artifactsSizeがmaxArtifactZipBytesを超えるジョブはtoo-largeでスキップする', async () => {
    const manager = new ArtifactCacheManager(gateway, {
      maxArtifactZipBytes: 100,
      totalDiskBytes: 10000,
    });
    const jobs = [makeJob({ id: 1, hasArtifacts: true, artifactsSize: 200 })];

    const result = await manager.prefetchForJobs(42, jobs);

    expect(result.get(1)).toEqual({
      kind: 'skipped-too-large',
      sizeBytes: 200,
    });
    expect(gateway.calls.length).toBe(0);
    await manager.cleanup();
  });

  it('累計サイズがtotalDiskBytesを超えるとそれ以降はdisk-fullでスキップする', async () => {
    gateway = new FakePipelineGateway({ writtenBytes: 400, reportedBytes: 400 });
    const manager = new ArtifactCacheManager(gateway, {
      maxArtifactZipBytes: 1000,
      totalDiskBytes: 500,
    });
    const jobs = [
      makeJob({ id: 1, hasArtifacts: true, artifactsSize: 400 }),
      makeJob({ id: 2, hasArtifacts: true, artifactsSize: 400 }),
    ];

    const result = await manager.prefetchForJobs(42, jobs);

    expect(result.get(1)?.kind).toBe('cached');
    expect(result.get(2)).toEqual({
      kind: 'skipped-disk-full',
      sizeBytes: 400,
    });
    // job2はダウンロードされない
    expect(gateway.calls.map((c) => c.jobId)).toEqual([1]);
    await manager.cleanup();
  });

  it('正常系ではzipが一時ディレクトリに保存される', async () => {
    const manager = new ArtifactCacheManager(gateway, {
      maxArtifactZipBytes: 1000,
      totalDiskBytes: 10000,
    });
    const jobs = [makeJob({ id: 7, hasArtifacts: true, artifactsSize: 100 })];

    const result = await manager.prefetchForJobs(42, jobs);

    const entry = result.get(7);
    expect(entry?.kind).toBe('cached');
    if (entry?.kind !== 'cached') throw new Error('expected cached');
    // 物理ファイルが存在する
    const st = await stat(entry.zipPath);
    expect(st.isFile()).toBe(true);
    expect(entry.bytes).toBe(100);
    expect(manager.getZipPath(7)).toBe(entry.zipPath);
    expect(gateway.calls[0]).toMatchObject({
      projectId: 42,
      jobId: 7,
      maxBytes: 1000,
    });

    await manager.cleanup();
  });

  it('cleanupで一時ディレクトリが削除される', async () => {
    const manager = new ArtifactCacheManager(gateway, {
      maxArtifactZipBytes: 1000,
      totalDiskBytes: 10000,
    });
    const jobs = [makeJob({ id: 1, hasArtifacts: true, artifactsSize: 100 })];

    const result = await manager.prefetchForJobs(42, jobs);
    const cached = result.get(1);
    if (cached?.kind !== 'cached') throw new Error('expected cached');
    const zipPath = cached.zipPath;

    await manager.cleanup();

    await expect(stat(zipPath)).rejects.toThrow();
    expect(manager.getZipPath(1)).toBeNull();
  });

  it('gatewayが例外を投げた場合はerrorステータスを記録して続行する', async () => {
    gateway = new FakePipelineGateway({ writtenBytes: 0, shouldThrow: true });
    const manager = new ArtifactCacheManager(gateway, {
      maxArtifactZipBytes: 1000,
      totalDiskBytes: 10000,
    });
    const jobs = [
      makeJob({ id: 1, hasArtifacts: true, artifactsSize: 100 }),
      makeJob({ id: 2, hasArtifacts: true, artifactsSize: 100 }),
    ];

    const result = await manager.prefetchForJobs(42, jobs);

    const e1 = result.get(1);
    const e2 = result.get(2);
    expect(e1?.kind).toBe('error');
    expect(e2?.kind).toBe('error');
    if (e1?.kind === 'error') {
      expect(e1.reason).toContain('simulated download failure');
    }
    // 両方試行されている
    expect(gateway.calls.map((c) => c.jobId)).toEqual([1, 2]);
    await manager.cleanup();
  });
});
