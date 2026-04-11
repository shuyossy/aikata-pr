import { describe, it, expect } from 'vitest';
import { Job, type JobParams } from '../Job.js';

function baseParams(overrides: Partial<JobParams> = {}): JobParams {
  return {
    id: 1,
    name: 'build',
    stage: 'build',
    status: 'success',
    startedAt: new Date('2026-04-11T00:00:00Z'),
    finishedAt: new Date('2026-04-11T00:05:00Z'),
    duration: 300,
    webUrl: 'https://gitlab.example.com/root/project/-/jobs/1',
    failureReason: null,
    hasArtifacts: false,
    artifactsSize: 0,
    ...overrides,
  };
}

describe('Job', () => {
  it('ofでファクトリ生成した値が全フィールドに反映される', () => {
    const params = baseParams();
    const job = Job.of(params);

    expect(job.id).toBe(params.id);
    expect(job.name).toBe(params.name);
    expect(job.stage).toBe(params.stage);
    expect(job.status).toBe(params.status);
    expect(job.startedAt).toBe(params.startedAt);
    expect(job.finishedAt).toBe(params.finishedAt);
    expect(job.duration).toBe(params.duration);
    expect(job.webUrl).toBe(params.webUrl);
    expect(job.failureReason).toBe(params.failureReason);
    expect(job.hasArtifacts).toBe(params.hasArtifacts);
    expect(job.artifactsSize).toBe(params.artifactsSize);
  });

  it('startedAt / finishedAt / duration / failureReasonはnullを許容する', () => {
    const job = Job.of(
      baseParams({
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        duration: null,
        failureReason: null,
      }),
    );
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(job.duration).toBeNull();
    expect(job.failureReason).toBeNull();
  });

  it('failureReasonを保持できる', () => {
    const job = Job.of(
      baseParams({
        status: 'failed',
        failureReason: 'script_failure',
      }),
    );
    expect(job.failureReason).toBe('script_failure');
  });

  it('idが0以下の場合はエラーになる', () => {
    expect(() => Job.of(baseParams({ id: 0 }))).toThrow(/id must be positive/);
    expect(() => Job.of(baseParams({ id: -1 }))).toThrow(/id must be positive/);
  });

  it('アーティファクト情報を保持できる', () => {
    const job = Job.of(baseParams({ hasArtifacts: true, artifactsSize: 2048 }));
    expect(job.hasArtifacts).toBe(true);
    expect(job.artifactsSize).toBe(2048);
  });
});
