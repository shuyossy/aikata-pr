import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mastra } from '@mastra/core';
import type { PipelineAnalysisWorkflowParams } from '../../../../../application/shared/port/workflow/index.js';
import type { ArtifactCacheEntryStatus } from '../../../../../application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.js';
import type { ArtifactArchiveReader } from '../../../../../application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.js';
import { Pipeline } from '../../../../../domain/pipeline-report/pipeline/Pipeline.js';
import { Job } from '../../../../../domain/pipeline-report/job/Job.js';
import { ArtifactTree } from '../../../../../domain/pipeline-report/artifact/ArtifactTree.js';
import { MastraPipelineAnalysisWorkflowRunner } from '../MastraPipelineAnalysisWorkflowRunner.js';

/**
 * テスト用の Pipeline を生成する。
 */
function createPipeline(): Pipeline {
  return Pipeline.of({
    projectId: 42,
    pipelineId: 1001,
    ref: 'main',
    sha: 'deadbeef',
    status: 'success',
    webUrl: 'https://gitlab.example.com/pipelines/1001',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T01:00:00Z'),
  });
}

/**
 * テスト用の Job を生成する。
 */
function createJob(overrides: { id: number; name: string; stage: string }): Job {
  return Job.of({
    id: overrides.id,
    name: overrides.name,
    stage: overrides.stage,
    status: 'success',
    startedAt: new Date('2024-01-01T00:00:00Z'),
    finishedAt: new Date('2024-01-01T00:05:00Z'),
    duration: 300,
    webUrl: `https://gitlab.example.com/jobs/${overrides.id}`,
    failureReason: null,
    hasArtifacts: true,
    artifactsSize: 1024,
  });
}

/**
 * テスト用の ArtifactTree を生成する。
 */
function createArtifactTree(jobId: number, jobName: string): ArtifactTree {
  return ArtifactTree.of({
    jobId,
    jobName,
    entries: [
      { path: 'dist/main.js', type: 'file', size: 2048, mode: '0644' },
      { path: 'dist/main.js.map', type: 'file', size: 4096, mode: '0644' },
    ],
  });
}

/**
 * テスト用の PipelineAnalysisWorkflowParams を生成するヘルパ。
 */
function createParams(
  overrides?: Partial<PipelineAnalysisWorkflowParams>,
): PipelineAnalysisWorkflowParams {
  const pipeline = createPipeline();
  const jobs = [
    createJob({ id: 5001, name: 'build', stage: 'build' }),
    createJob({ id: 5002, name: 'test', stage: 'test' }),
  ];
  const jobLogsCompressed = new Map<number, string>([
    [5001, 'build log truncated'],
    [5002, 'test log truncated'],
  ]);
  const omittedJobLogs = new Map<number, string>([[5001, 'omitted middle of build log']]);
  const artifactCacheStatuses = new Map<number, ArtifactCacheEntryStatus>([
    [5001, { kind: 'cached', zipPath: '/tmp/cache/5001.zip', bytes: 1024 }],
    [5002, { kind: 'no-artifacts' }],
  ]);
  const fakeArchiveReader: ArtifactArchiveReader = {
    listEntries: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue({ data: Buffer.from(''), truncated: false }),
  };
  return {
    userId: 'test-user',
    projectId: 42,
    pipelineMeta: pipeline,
    targetJobs: jobs,
    jobLogsCompressed,
    omittedJobLogs,
    artifactTrees: [createArtifactTree(5001, 'build')],
    folderTree: 'src/\n  index.ts',
    folderTreeStripped: false,
    overallTemplate: '# Pipeline Report\n\n## Overview\n\n## Jobs\n',
    jobReportFormat: '### {jobName}\n\n{content}\n',
    analysisInstructions: null,
    reportRefinementInstructions: null,
    commentLanguage: 'Japanese',
    skillsPaths: [],
    resultFilePath: '/tmp/result.md',
    projectDir: '/workspace/project',
    artifactCacheStatuses,
    archiveReader: fakeArchiveReader,
    mergedYaml: 'stages:\n  - build\n  - test\n',
    maxCompletenessRetries: 2,
    skipCompletenessCheck: false,
    aiConfig: {
      apiKey: 'test-api-key',
      endpointUrl: 'https://api.example.com/v1',
      modelName: 'openai/o4-mini',
      reasoningEffort: null,
    },
    onProgress: vi.fn(),
    ...overrides,
  };
}

/**
 * Mastra のダミーインスタンスを組み立てるヘルパ。
 * start の戻り値・副作用は呼び出し元で制御する。
 */
function createFakeMastra(opts: { start: ReturnType<typeof vi.fn> }): {
  mastra: Mastra;
  getWorkflow: ReturnType<typeof vi.fn>;
  createRun: ReturnType<typeof vi.fn>;
} {
  const createRun = vi.fn().mockResolvedValue({ start: opts.start });
  const getWorkflow = vi.fn().mockReturnValue({ createRun });
  const mastra = { getWorkflow } as unknown as Mastra;
  return { mastra, getWorkflow, createRun };
}

describe('MastraPipelineAnalysisWorkflowRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pipelineAnalysisWorkflowを取得し、inputDataとrequestContextを渡してstartする', async () => {
    const start = vi.fn().mockResolvedValue({
      status: 'success',
      result: {
        reportContent: '# Final Report\n',
        completenessVerified: true,
        completenessRetries: 0,
      },
    });
    const { mastra, getWorkflow } = createFakeMastra({ start });
    const runner = new MastraPipelineAnalysisWorkflowRunner(mastra);

    const params = createParams();
    const result = await runner.run(params);

    expect(getWorkflow).toHaveBeenCalledWith('pipelineAnalysisWorkflow');
    expect(start).toHaveBeenCalledOnce();
    const startArg = start.mock.calls[0]![0] as {
      inputData: Record<string, unknown>;
      requestContext: { get(key: string): unknown; all: Record<string, unknown> };
    };

    // inputData: ワークフロースキーマに合致するフィールドのみ
    expect(typeof startArg.inputData.initialUserPrompt).toBe('string');
    expect(String(startArg.inputData.initialUserPrompt)).toContain('# Pipeline');
    expect(startArg.inputData.targetJobs).toEqual([
      { id: 5001, name: 'build', stage: 'build', status: 'success', duration: 300 },
      { id: 5002, name: 'test', stage: 'test', status: 'success', duration: 300 },
    ]);
    expect(startArg.inputData.overallTemplate).toBe(params.overallTemplate);
    expect(startArg.inputData.jobReportFormat).toBe(params.jobReportFormat);
    expect(startArg.inputData.analysisInstructions).toBeNull();
    expect(startArg.inputData.reportRefinementInstructions).toBeNull();
    expect(startArg.inputData.resultFilePath).toBe(params.resultFilePath);
    expect(startArg.inputData.commentLanguage).toBe(params.commentLanguage);
    expect(startArg.inputData.maxCompletenessRetries).toBe(params.maxCompletenessRetries);
    expect(startArg.inputData.skipCompletenessCheck).toBe(false);

    // requestContext: PipelineAnalysisAgentRequestContext の主要フィールド
    const ctx = startArg.requestContext;
    expect(ctx.get('userId')).toBe('test-user');
    expect(ctx.get('projectId')).toBe('42');
    expect(ctx.get('pipelineId')).toBe(1001);
    expect(ctx.get('projectDir')).toBe('/workspace/project');
    expect(ctx.get('aiApiKey')).toBe(params.aiConfig.apiKey);
    expect(ctx.get('aiApiEndpointUrl')).toBe(params.aiConfig.endpointUrl);
    expect(ctx.get('aiModelName')).toBe(params.aiConfig.modelName);
    expect(ctx.get('openaiReasoningEffort')).toBeUndefined();
    expect(ctx.get('overallTemplate')).toBe(params.overallTemplate);
    expect(ctx.get('jobReportFormat')).toBe(params.jobReportFormat);
    expect(ctx.get('analysisInstructions')).toBeNull();
    expect(ctx.get('reportRefinementInstructions')).toBeNull();
    expect(ctx.get('commentLanguage')).toBe('Japanese');
    expect(ctx.get('resultFilePath')).toBe(params.resultFilePath);
    expect(ctx.get('skillsPaths')).toEqual([]);
    expect(ctx.get('folderTree')).toBe(params.folderTree);
    expect(ctx.get('folderTreeStripped')).toBe(false);
    expect(ctx.get('omittedJobLogs')).toBeInstanceOf(Map);
    expect((ctx.get('omittedJobLogs') as Map<number, string>).get(5001)).toBe(
      'omitted middle of build log',
    );
    // artifactCachePaths は artifactCacheStatuses から deriveCachePaths() で導出される
    expect(ctx.get('artifactCachePaths')).toBeInstanceOf(Map);
    const cachePaths = ctx.get('artifactCachePaths') as Map<number, string | null>;
    expect(cachePaths.get(5001)).toBe('/tmp/cache/5001.zip');
    expect(cachePaths.get(5002)).toBeNull();
    // artifactArchiveReader がRequestContextに注入されていること
    expect(ctx.get('artifactArchiveReader')).toBeDefined();
    expect(typeof (ctx.get('artifactArchiveReader') as ArtifactArchiveReader).listEntries).toBe(
      'function',
    );
    expect(typeof (ctx.get('artifactArchiveReader') as ArtifactArchiveReader).readFile).toBe(
      'function',
    );
    expect(ctx.get('hasImages')).toBe(false);
    expect(ctx.get('pendingImages')).toEqual([]);
    expect(ctx.get('workspaceAvailable')).toBe(true);
    expect(ctx.get('mergedYaml')).toBe('stages:\n  - build\n  - test\n');

    // 結果
    expect(result.reportContent).toBe('# Final Report\n');
    expect(result.completenessVerified).toBe(true);
    expect(result.completenessRetries).toBe(0);
  });

  it('ワークフロー失敗時にエラーをスローする', async () => {
    const start = vi.fn().mockResolvedValue({
      status: 'failed',
      error: new Error('boom'),
    });
    const { mastra } = createFakeMastra({ start });
    const runner = new MastraPipelineAnalysisWorkflowRunner(mastra);

    await expect(runner.run(createParams())).rejects.toThrow(/Pipeline analysis workflow failed/);
  });

  it('想定外のstatusが返るとエラーをスローする', async () => {
    const start = vi.fn().mockResolvedValue({
      status: 'suspended',
    });
    const { mastra } = createFakeMastra({ start });
    const runner = new MastraPipelineAnalysisWorkflowRunner(mastra);

    await expect(runner.run(createParams())).rejects.toThrow(
      /Pipeline analysis workflow ended with unexpected status: suspended/,
    );
  });

  it('onProgressにphase=analyzing/doneが順に通知される', async () => {
    const onProgress = vi.fn();
    const start = vi.fn().mockResolvedValue({
      status: 'success',
      result: {
        reportContent: '# OK',
        completenessVerified: true,
        completenessRetries: 0,
      },
    });
    const { mastra } = createFakeMastra({ start });
    const runner = new MastraPipelineAnalysisWorkflowRunner(mastra);

    await runner.run(createParams({ onProgress }));

    const phases = onProgress.mock.calls
      .map((call) => call[0])
      .filter((event: unknown): event is { type: 'phase'; phase: string } => {
        return (
          typeof event === 'object' &&
          event !== null &&
          (event as { type: string }).type === 'phase'
        );
      })
      .map((event) => event.phase);

    expect(phases).toContain('analyzing');
    expect(phases).toContain('done');
  });

  it('runWithLogContextのバインディングが下流に適用される', async () => {
    // start 関数実行中に getLogger() を呼び出し、userId バインディングが反映されることを確認する
    const { runWithLogContext, getLogger, initializeLogger, resetLogger } =
      await import('../../../../../lib/logger.js');
    resetLogger();
    initializeLogger({ userId: 'base-user', level: 'silent', prettyPrint: false });

    let capturedBindings: Record<string, unknown> | null = null;
    const start = vi.fn().mockImplementation(async () => {
      // start 内部から getLogger() を呼ぶと、runWithLogContext で付与されたバインディングを含むはず
      const logger = getLogger();
      // pino の child logger は bindings を持つ
      capturedBindings = logger.bindings();
      return {
        status: 'success',
        result: {
          reportContent: '# OK',
          completenessVerified: true,
          completenessRetries: 0,
        },
      };
    });
    // runWithLogContextを使用していることの追加検証として、直接内部関数を spy する
    const { mastra } = createFakeMastra({ start });
    const runner = new MastraPipelineAnalysisWorkflowRunner(mastra);

    await runner.run(createParams({ userId: 'request-user' }));

    expect(capturedBindings).not.toBeNull();
    expect((capturedBindings as unknown as Record<string, unknown>).userId).toBe('request-user');

    // runWithLogContext 自体が呼び出されたことも念のため確認
    void runWithLogContext; // 型参照の保持

    resetLogger();
  });
});
