import { describe, it, expect } from 'vitest';
import { Pipeline, type PipelineParams } from '../Pipeline.js';

// 正常系パラメータのベースを生成するヘルパー
function baseParams(overrides: Partial<PipelineParams> = {}): PipelineParams {
  return {
    projectId: 10,
    pipelineId: 100,
    ref: 'main',
    sha: 'abcdef1234567890',
    status: 'success',
    webUrl: 'https://gitlab.example.com/root/project/-/pipelines/100',
    createdAt: new Date('2026-04-11T00:00:00Z'),
    updatedAt: new Date('2026-04-11T00:10:00Z'),
    ...overrides,
  };
}

describe('Pipeline', () => {
  it('ofでファクトリ生成した値が全フィールドに反映される', () => {
    const params = baseParams();
    const pipeline = Pipeline.of(params);

    expect(pipeline.projectId).toBe(params.projectId);
    expect(pipeline.pipelineId).toBe(params.pipelineId);
    expect(pipeline.ref).toBe(params.ref);
    expect(pipeline.sha).toBe(params.sha);
    expect(pipeline.status).toBe(params.status);
    expect(pipeline.webUrl).toBe(params.webUrl);
    expect(pipeline.createdAt).toBe(params.createdAt);
    expect(pipeline.updatedAt).toBe(params.updatedAt);
  });

  it('projectIdが0以下の場合はエラーになる', () => {
    expect(() => Pipeline.of(baseParams({ projectId: 0 }))).toThrow(/projectId must be positive/);
    expect(() => Pipeline.of(baseParams({ projectId: -1 }))).toThrow(/projectId must be positive/);
  });

  it('pipelineIdが0以下の場合はエラーになる', () => {
    expect(() => Pipeline.of(baseParams({ pipelineId: 0 }))).toThrow(/pipelineId must be positive/);
    expect(() => Pipeline.of(baseParams({ pipelineId: -5 }))).toThrow(
      /pipelineId must be positive/,
    );
  });

  it('shaが空文字の場合はエラーになる', () => {
    expect(() => Pipeline.of(baseParams({ sha: '' }))).toThrow(/sha must not be empty/);
  });

  it('様々なPipelineStatusを受け入れる', () => {
    const statuses = ['running', 'failed', 'canceled', 'manual'] as const;
    for (const status of statuses) {
      const pipeline = Pipeline.of(baseParams({ status }));
      expect(pipeline.status).toBe(status);
    }
  });
});
