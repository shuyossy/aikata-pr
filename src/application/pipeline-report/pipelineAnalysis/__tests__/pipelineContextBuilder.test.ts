import { describe, it, expect } from 'vitest';
import { buildPipelineUserPrompt } from '../pipelineContextBuilder.js';
import { Pipeline } from '../../../../domain/pipeline-report/pipeline/index.js';
import { Job } from '../../../../domain/pipeline-report/job/index.js';
import { ArtifactTree } from '../../../../domain/pipeline-report/artifact/index.js';
import type { ArtifactCacheEntryStatus } from '../ArtifactCacheManager.js';

// ヘルパー: テスト用のPipelineを生成
function createPipeline(overrides?: Partial<Parameters<typeof Pipeline.of>[0]>): Pipeline {
  return Pipeline.of({
    projectId: 100,
    pipelineId: 2001,
    ref: 'main',
    sha: 'abc123def456',
    status: 'failed',
    webUrl: 'https://gitlab.example.com/org/project/-/pipelines/2001',
    createdAt: new Date('2026-04-11T09:00:00Z'),
    updatedAt: new Date('2026-04-11T09:15:00Z'),
    ...overrides,
  });
}

// ヘルパー: テスト用のJobを生成
function createJob(overrides?: Partial<Parameters<typeof Job.of>[0]>): Job {
  return Job.of({
    id: 5001,
    name: 'test:unit',
    stage: 'test',
    status: 'failed',
    startedAt: new Date('2026-04-11T09:01:00Z'),
    finishedAt: new Date('2026-04-11T09:05:00Z'),
    duration: 240,
    webUrl: 'https://gitlab.example.com/org/project/-/jobs/5001',
    failureReason: 'script_failure',
    hasArtifacts: true,
    artifactsSize: 2048,
    ...overrides,
  });
}

describe('buildPipelineUserPrompt', () => {
  it('正常系: 全セクションが期待通り組み立てられる', () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, name: 'build', stage: 'build', status: 'success' });
    const jobB = createJob({ id: 5002, name: 'test:unit', stage: 'test', status: 'failed' });
    const targetJobs = [jobA, jobB];

    const jobLogs = new Map<number, string>([
      [5001, 'Running build...\nbuild succeeded\n'],
      [5002, 'Running tests...\nTest failed\n'],
    ]);

    const artifactTrees = [
      ArtifactTree.of({
        jobId: 5001,
        jobName: 'build',
        entries: [
          { path: 'dist/app.js', type: 'file', size: 1024, mode: '100644' },
          { path: 'dist/app.js.map', type: 'file', size: 512, mode: '100644' },
        ],
      }),
      ArtifactTree.of({
        jobId: 5002,
        jobName: 'test:unit',
        entries: [{ path: 'junit.xml', type: 'file', size: 256, mode: '100644' }],
      }),
    ];

    const artifactCacheStatuses = new Map<number, ArtifactCacheEntryStatus>([
      [5001, { kind: 'cached', zipPath: '/tmp/job-5001.zip', bytes: 1536 }],
      [5002, { kind: 'cached', zipPath: '/tmp/job-5002.zip', bytes: 256 }],
    ]);

    const folderTree = 'src/\n  index.ts\n  app.ts\n';

    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs,
      jobLogs,
      artifactTrees,
      artifactCacheStatuses,
      folderTree,
      folderTreeStripped: false,
    });

    // Pipeline セクション
    expect(prompt).toContain('## Pipeline');
    expect(prompt).toContain('2001');
    expect(prompt).toContain('main');
    expect(prompt).toContain('abc123def456');
    expect(prompt).toContain('failed');
    expect(prompt).toContain('https://gitlab.example.com/org/project/-/pipelines/2001');

    // Jobs セクション
    expect(prompt).toContain('## Jobs (2 analyzed)');
    expect(prompt).toContain('5001');
    expect(prompt).toContain('5002');
    expect(prompt).toContain('build');
    expect(prompt).toContain('test:unit');

    // Job Logs セクション
    expect(prompt).toContain('## Job Logs');
    expect(prompt).toContain('Job #5001');
    expect(prompt).toContain('build succeeded');
    expect(prompt).toContain('Job #5002');
    expect(prompt).toContain('Test failed');

    // Artifact Paths セクション
    expect(prompt).toContain('## Artifact Paths');
    expect(prompt).toContain('dist/app.js');
    expect(prompt).toContain('junit.xml');

    // Source Code Paths セクション
    expect(prompt).toContain('## Source Code Paths');
    expect(prompt).toContain('src/');
    expect(prompt).toContain('index.ts');
  });

  it('folderTreeStripped=trueの場合、注釈が含まれる', () => {
    const pipeline = createPipeline();
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [createJob()],
      jobLogs: new Map([[5001, 'log']]),
      artifactTrees: [],
      artifactCacheStatuses: new Map([[5001, { kind: 'no-artifacts' }]]),
      folderTree: 'src/\n  (files omitted)',
      folderTreeStripped: true,
    });

    expect(prompt).toContain('file entries were stripped');
  });

  it('artifactがskipped-too-largeの場合、理由が含まれる', () => {
    const pipeline = createPipeline();
    const job = createJob({ id: 5003, artifactsSize: 100 * 1024 * 1024 });
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [job],
      jobLogs: new Map([[5003, 'log']]),
      artifactTrees: [],
      artifactCacheStatuses: new Map([
        [5003, { kind: 'skipped-too-large', sizeBytes: 100 * 1024 * 1024 }],
      ]),
      folderTree: 'src/',
      folderTreeStripped: false,
    });

    expect(prompt).toContain('artifact zip too large');
    // サイズ表記に MB が含まれる
    expect(prompt).toContain('MB');
  });

  it('artifactがno-artifactsの場合、No artifacts相当の文言が含まれる', () => {
    const pipeline = createPipeline();
    const job = createJob({ id: 5004, hasArtifacts: false, artifactsSize: 0 });
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [job],
      jobLogs: new Map([[5004, 'log']]),
      artifactTrees: [],
      artifactCacheStatuses: new Map([[5004, { kind: 'no-artifacts' }]]),
      folderTree: 'src/',
      folderTreeStripped: false,
    });

    expect(prompt).toContain('no artifacts');
  });

  it('skipped-disk-fullの場合、理由が含まれる', () => {
    const pipeline = createPipeline();
    const job = createJob({ id: 5005, artifactsSize: 10 * 1024 * 1024 });
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [job],
      jobLogs: new Map([[5005, 'log']]),
      artifactTrees: [],
      artifactCacheStatuses: new Map([
        [5005, { kind: 'skipped-disk-full', sizeBytes: 10 * 1024 * 1024 }],
      ]),
      folderTree: 'src/',
      folderTreeStripped: false,
    });

    expect(prompt).toContain('disk quota exceeded');
  });

  it('errorステータスの場合、エラー理由が含まれる', () => {
    const pipeline = createPipeline();
    const job = createJob({ id: 5006 });
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [job],
      jobLogs: new Map([[5006, 'log']]),
      artifactTrees: [],
      artifactCacheStatuses: new Map([[5006, { kind: 'error', reason: 'network timeout' }]]),
      folderTree: 'src/',
      folderTreeStripped: false,
    });

    expect(prompt).toContain('artifact fetch error');
    expect(prompt).toContain('network timeout');
  });

  it('対象ジョブが空の場合、No target jobs相当の文言が含まれる', () => {
    const pipeline = createPipeline();
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [],
      jobLogs: new Map(),
      artifactTrees: [],
      artifactCacheStatuses: new Map(),
      folderTree: 'src/',
      folderTreeStripped: false,
    });

    // Jobs ヘッダは存在する
    expect(prompt).toContain('## Jobs (0 analyzed)');
    expect(prompt).toContain('No target jobs');
  });

  it('ジョブログが存在しないジョブでも落ちずにセクションが生成される', () => {
    const pipeline = createPipeline();
    const job = createJob({ id: 5007 });
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [job],
      jobLogs: new Map(), // 5007 は無い
      artifactTrees: [],
      artifactCacheStatuses: new Map([[5007, { kind: 'no-artifacts' }]]),
      folderTree: 'src/',
      folderTreeStripped: false,
    });

    expect(prompt).toContain('Job #5007');
    // ログが無い旨の文言
    expect(prompt).toContain('no log');
  });

  it('Pipelineメタ情報のprojectIdを出力する', () => {
    const pipeline = createPipeline({ projectId: 777 });
    const prompt = buildPipelineUserPrompt({
      pipeline,
      targetJobs: [],
      jobLogs: new Map(),
      artifactTrees: [],
      artifactCacheStatuses: new Map(),
      folderTree: '',
      folderTreeStripped: false,
    });

    expect(prompt).toContain('777');
  });
});
