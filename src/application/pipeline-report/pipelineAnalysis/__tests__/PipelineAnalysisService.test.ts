import * as fs from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineAnalysisService } from '../PipelineAnalysisService.js';
import type { PipelineAnalyzeCommand } from '../PipelineAnalysisService.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';
import type { PipelineGateway } from '../../../shared/port/gateway/PipelineGateway.js';
import type { ProjectTreeGateway } from '../../../shared/port/gateway/ProjectTreeGateway.js';
import type {
  PipelineAnalysisWorkflowRunner,
  PipelineAnalysisWorkflowResult,
} from '../../../shared/port/workflow/PipelineAnalysisWorkflowRunner.js';
import type { TokenCounter } from '../../../shared/port/tokenCounter/TokenCounter.js';
import type { ArtifactArchiveReader } from '../ArtifactArchiveReader.js';
import { ArtifactCacheManager } from '../ArtifactCacheManager.js';
import { Pipeline } from '../../../../domain/pipeline-report/pipeline/index.js';
import { Job } from '../../../../domain/pipeline-report/job/index.js';
import { PipelineReportSettings } from '../../../../domain/pipeline-report/pipelineReportSettings/index.js';

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

// ヘルパー: テスト用のコマンドを生成
function createCommand(overrides?: Partial<PipelineAnalyzeCommand>): PipelineAnalyzeCommand {
  return {
    userId: 'test-user',
    projectId: 100,
    pipelineId: 2001,
    selfJobId: null,
    settings: PipelineReportSettings.default(),
    projectDir: '/tmp/test-project',
    commentLanguage: 'English',
    skillsPaths: [],
    aiConfig: {
      apiKey: 'test-key',
      endpointUrl: 'https://ai.example.com',
      modelName: 'openai/o4-mini',
      reasoningEffort: null,
    },
    maxContextLength: null,
    treeMaxDepth: undefined,
    options: { maxCompletenessRetries: 3 },
    onProgress: () => {
      /* no-op */
    },
    ...overrides,
  };
}

// ヘルパー: テスト用のワークフロー結果を生成
function createWorkflowResult(
  overrides?: Partial<PipelineAnalysisWorkflowResult>,
): PipelineAnalysisWorkflowResult {
  return {
    reportContent: '# Test report',
    completenessVerified: true,
    completenessRetries: 0,
    ...overrides,
  };
}

describe('PipelineAnalysisService', () => {
  let pipelineGateway: PipelineGateway;
  let projectTreeGateway: ProjectTreeGateway;
  let workflowRunner: PipelineAnalysisWorkflowRunner;
  let tokenCounter: TokenCounter;
  let archiveReader: ArtifactArchiveReader;
  let cacheManager: ArtifactCacheManager;
  let cleanupSpy: ReturnType<typeof vi.spyOn>;
  let createdResultFiles: string[];

  beforeEach(() => {
    // PipelineAnalysisService 内部の getLogger() 呼び出しが失敗しないよう初期化する
    initializeLogger({ userId: 'test-user', level: 'silent', prettyPrint: false });
    createdResultFiles = [];
    pipelineGateway = {
      getPipeline: vi.fn(),
      getJobs: vi.fn(),
      getJobTrace: vi.fn(),
      getMergedYaml: vi.fn().mockResolvedValue('stages:\n  - build\n  - test\n'),
      downloadArtifactArchive: vi.fn(),
    };
    projectTreeGateway = {
      getTree: vi.fn().mockResolvedValue('src/\n  index.ts\n'),
    };
    workflowRunner = {
      run: vi.fn(),
    };
    tokenCounter = {
      countTokens: vi.fn().mockReturnValue(100),
    };
    archiveReader = {
      listEntries: vi.fn().mockResolvedValue([]),
      readFile: vi.fn(),
    };
    cacheManager = new ArtifactCacheManager(pipelineGateway, {
      maxArtifactZipBytes: 50 * 1024 * 1024,
      totalDiskBytes: 500 * 1024 * 1024,
    });
    // cleanup の呼び出しを検知する
    cleanupSpy = vi.spyOn(cacheManager, 'cleanup');
    // prefetchForJobs をデフォルトでスタブ: 引数のジョブについて cached エントリを返す
    vi.spyOn(cacheManager, 'prefetchForJobs').mockImplementation(async (_projectId, jobs) => {
      const result = new Map();
      for (const job of jobs) {
        if (!job.hasArtifacts) {
          result.set(job.id, { kind: 'no-artifacts' as const });
        } else {
          result.set(job.id, {
            kind: 'cached' as const,
            zipPath: `/tmp/fake-job-${job.id}.zip`,
            bytes: job.artifactsSize,
          });
        }
      }
      return result;
    });
    // getZipPath: cachedの場合はfakeパスを返す
    vi.spyOn(cacheManager, 'getZipPath').mockImplementation(
      (jobId) => `/tmp/fake-job-${jobId}.zip`,
    );
  });

  afterEach(() => {
    // テストで生成された結果ファイルをクリーンアップ
    for (const filePath of createdResultFiles) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(`${filePath}.lock`);
      } catch {
        /* ignore */
      }
    }
    resetLogger();
  });

  it('正常系: Pipeline取得→Job取得→ログ取得→artifactプリフェッチ→workflow実行→結果返却', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, name: 'build', stage: 'build', status: 'success' });
    const jobB = createJob({ id: 5002, name: 'test:unit', stage: 'test', status: 'failed' });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA, jobB]);
    vi.mocked(pipelineGateway.getJobTrace).mockImplementation(
      async (_p, jobId) => `log for ${jobId}`,
    );
    vi.mocked(archiveReader.listEntries).mockResolvedValue([
      { path: 'dist/app.js', type: 'file' as const, size: 1024, mode: '100644' },
    ]);

    const workflowResult = createWorkflowResult();
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      // workflow が呼ばれた時点で resultFilePath にはテンプレートが書き込まれている想定
      // runner 側で最終レポートを書き込むのをエミュレート
      fs.writeFileSync(params.resultFilePath, '# Final report content\n- done');
      return workflowResult;
    });

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    const result = await service.analyze(command);

    // 各ゲートウェイが呼ばれた
    expect(pipelineGateway.getPipeline).toHaveBeenCalledWith(100, 2001);
    expect(pipelineGateway.getJobs).toHaveBeenCalledWith(100, 2001, { includeRetried: false });
    expect(pipelineGateway.getJobTrace).toHaveBeenCalledTimes(2);
    // treeMaxDepth が command 経由で gateway に伝播する（デフォルトは undefined）
    expect(projectTreeGateway.getTree).toHaveBeenCalledWith('/tmp/test-project', {
      maxDepth: undefined,
    });
    expect(cacheManager.prefetchForJobs).toHaveBeenCalled();
    // cachedジョブのzipはlistEntriesが呼ばれる
    expect(archiveReader.listEntries).toHaveBeenCalled();
    expect(workflowRunner.run).toHaveBeenCalledOnce();

    // workflow runner に渡されたパラメータ
    const runnerCall = vi.mocked(workflowRunner.run).mock.calls[0]![0];
    expect(runnerCall.pipelineMeta).toBe(pipeline);
    expect(runnerCall.targetJobs).toHaveLength(2);
    expect(runnerCall.jobLogsCompressed.get(5001)).toBe('log for 5001');
    expect(runnerCall.jobLogsCompressed.get(5002)).toBe('log for 5002');
    // サービス内部で一時ファイルパスが生成される（/tmp/aikata-pipeline-report-...）
    expect(runnerCall.resultFilePath).toMatch(/^\/tmp\/aikata-pipeline-report-/);
    expect(runnerCall.aiConfig.modelName).toBe('openai/o4-mini');
    expect(runnerCall.mergedYaml).toBe('stages:\n  - build\n  - test\n');
    // artifactCacheStatuses がフル情報で渡されている
    expect(runnerCall.artifactCacheStatuses.get(5001)).toEqual(
      expect.objectContaining({ kind: 'cached' }),
    );
    expect(runnerCall.artifactCacheStatuses.get(5002)).toEqual(
      expect.objectContaining({ kind: 'cached' }),
    );

    // 結果
    expect(result.report.content).toBe('# Final report content\n- done');
    expect(result.completenessVerified).toBe(true);
    expect(result.completenessRetries).toBe(0);
    expect(result.targetJobs).toHaveLength(2);
    expect(result.pipeline).toBe(pipeline);

    // cleanup が呼ばれた
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('selfJobIdと一致するジョブは除外される', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, name: 'build', stage: 'build' });
    const jobB = createJob({ id: 5002, name: 'pipeline-report', stage: 'report' });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA, jobB]);
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue('log');
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Report');
      return createWorkflowResult();
    });

    const command = createCommand({ selfJobId: 5002 });
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    await service.analyze(command);

    const runnerCall = vi.mocked(workflowRunner.run).mock.calls[0]![0];
    expect(runnerCall.targetJobs).toHaveLength(1);
    expect(runnerCall.targetJobs[0]!.id).toBe(5001);
  });

  it('対象ジョブが0件の場合、workflowは呼ばれず最小レポートを返す', async () => {
    const pipeline = createPipeline();
    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([]);

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    const result = await service.analyze(command);

    expect(workflowRunner.run).not.toHaveBeenCalled();
    expect(result.targetJobs).toHaveLength(0);
    expect(result.report.isEmpty()).toBe(true);
    expect(result.completenessVerified).toBe(true);
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('getPipelineが失敗した場合、例外が伝播しcleanupは呼ばれる', async () => {
    const error = new Error('GitLab API down');
    vi.mocked(pipelineGateway.getPipeline).mockRejectedValue(error);

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    await expect(service.analyze(command)).rejects.toThrow('GitLab API down');
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('archiveReader.listEntriesが失敗した場合、そのジョブはartifactなしで続行しworkflow実行される', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001 });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA]);
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue('log');
    vi.mocked(archiveReader.listEntries).mockRejectedValue(new Error('corrupt zip'));
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Report');
      return createWorkflowResult();
    });

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    const result = await service.analyze(command);

    // workflow が実行されており、artifactTrees は空（listEntries失敗したため）
    expect(workflowRunner.run).toHaveBeenCalledOnce();
    const runnerCall = vi.mocked(workflowRunner.run).mock.calls[0]![0];
    expect(runnerCall.artifactTrees).toHaveLength(0);
    expect(result.completenessVerified).toBe(true);
  });

  it('completenessVerified=falseのworkflow結果を透過して返却する', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, hasArtifacts: false, artifactsSize: 0 });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA]);
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue('log');
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Incomplete report');
      return createWorkflowResult({ completenessVerified: false, completenessRetries: 3 });
    });

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    const result = await service.analyze(command);

    expect(result.completenessVerified).toBe(false);
    expect(result.completenessRetries).toBe(3);
    expect(result.report.content).toBe('# Incomplete report');
  });

  it('workflow実行中にエラーが発生してもcleanupは呼ばれる', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, hasArtifacts: false, artifactsSize: 0 });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA]);
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue('log');
    vi.mocked(workflowRunner.run).mockRejectedValue(new Error('workflow crashed'));

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    await expect(service.analyze(command)).rejects.toThrow('workflow crashed');
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('maxContextLength指定時、ログ圧縮が走り結果のtokenStatsに反映される', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, hasArtifacts: false, artifactsSize: 0 });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA]);
    // 長いログを返す（圧縮対象）
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => `log line ${i}`).join('\n'),
    );
    // 最初は閾値超過、圧縮後に閾値以内とする
    let callCount = 0;
    vi.mocked(tokenCounter.countTokens).mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? 10000 : 10;
    });
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Report');
      return createWorkflowResult();
    });

    const command = createCommand({ maxContextLength: 100 });
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    const result = await service.analyze(command);

    expect(result.tokenStats.compressed).toBe(true);
  });

  it('一部のジョブでgetJobTraceが失敗しても、残りのジョブとplaceholderでworkflowを実行する', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, name: 'build', stage: 'build', status: 'success' });
    const jobB = createJob({ id: 5002, name: 'test:unit', stage: 'test', status: 'failed' });
    const jobC = createJob({
      id: 5003,
      name: 'deploy',
      stage: 'deploy',
      status: 'success',
      hasArtifacts: false,
      artifactsSize: 0,
    });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA, jobB, jobC]);
    // jobB の trace 取得だけ失敗させる
    vi.mocked(pipelineGateway.getJobTrace).mockImplementation(async (_projectId, jobId) => {
      if (jobId === 5002) {
        throw new Error('upstream trace fetch error');
      }
      return `log for ${jobId}`;
    });
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Partial report');
      return createWorkflowResult();
    });

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    const result = await service.analyze(command);

    // workflow は中断されず実行される
    expect(workflowRunner.run).toHaveBeenCalledOnce();
    const runnerCall = vi.mocked(workflowRunner.run).mock.calls[0]![0];
    // 対象ジョブは 3 件全て残っており、jobLogs にも全 ID のエントリが入っている
    expect(runnerCall.targetJobs).toHaveLength(3);
    expect(runnerCall.jobLogsCompressed.size).toBe(3);
    // 成功したジョブは trace 本文が入る
    expect(runnerCall.jobLogsCompressed.get(5001)).toBe('log for 5001');
    expect(runnerCall.jobLogsCompressed.get(5003)).toBe('log for 5003');
    // 失敗したジョブは placeholder 本文が入る
    const placeholder = runnerCall.jobLogsCompressed.get(5002);
    expect(placeholder).toBeDefined();
    expect(placeholder).toContain('[aikata: failed to fetch job trace:');
    expect(placeholder).toContain('upstream trace fetch error');
    // サービスは完了し、最終レポートを返す
    expect(result.report.content).toBe('# Partial report');
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('treeMaxDepthがcommand経由でProjectTreeGatewayに伝播する', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, hasArtifacts: false, artifactsSize: 0 });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA]);
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue('log');
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Report');
      return createWorkflowResult();
    });

    const command = createCommand({ treeMaxDepth: 7, projectDir: '/tmp/custom-dir' });
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    await service.analyze(command);

    expect(projectTreeGateway.getTree).toHaveBeenCalledWith('/tmp/custom-dir', { maxDepth: 7 });
  });

  it('getMergedYamlがnullを返しても分析は続行される', async () => {
    const pipeline = createPipeline();
    const jobA = createJob({ id: 5001, hasArtifacts: false, artifactsSize: 0 });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA]);
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue('log');
    vi.mocked(pipelineGateway.getMergedYaml).mockResolvedValue(null);
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Report without YAML');
      return createWorkflowResult();
    });

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    const result = await service.analyze(command);

    expect(workflowRunner.run).toHaveBeenCalledOnce();
    const runnerCall = vi.mocked(workflowRunner.run).mock.calls[0]![0];
    expect(runnerCall.mergedYaml).toBeNull();
    expect(result.report.content).toBe('# Report without YAML');
  });

  it('getMergedYamlにはpipelineのshaが渡される', async () => {
    const pipeline = createPipeline({ sha: 'deadbeef1234' });
    const jobA = createJob({ id: 5001, hasArtifacts: false, artifactsSize: 0 });

    vi.mocked(pipelineGateway.getPipeline).mockResolvedValue(pipeline);
    vi.mocked(pipelineGateway.getJobs).mockResolvedValue([jobA]);
    vi.mocked(pipelineGateway.getJobTrace).mockResolvedValue('log');
    vi.mocked(workflowRunner.run).mockImplementation(async (params) => {
      fs.writeFileSync(params.resultFilePath, '# Report');
      return createWorkflowResult();
    });

    const command = createCommand();
    // サービスが内部で一時ファイルを生成・クリーンアップするため、テスト側でのクリーンアップ追跡は不要

    const service = new PipelineAnalysisService(
      pipelineGateway,
      projectTreeGateway,
      workflowRunner,
      tokenCounter,
      archiveReader,
      cacheManager,
    );

    await service.analyze(command);

    expect(pipelineGateway.getMergedYaml).toHaveBeenCalledWith(100, 'deadbeef1234');
  });
});
