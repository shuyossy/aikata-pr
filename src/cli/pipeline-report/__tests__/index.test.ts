import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, pipelineReportCliModule } from '../index.js';
import type { PipelineReportLocalDeps, PipelineReportApiDeps } from '../index.js';
import type { PipelineAnalysisResult } from '../../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import type {
  PipelineReportApiResult,
  PipelineReportApiClientHandlers,
} from '../../../infrastructure/adapter/pipeline-report/apiClient/index.js';
import { resetLogger } from '../../../lib/logger.js';
import { AnalysisReport } from '../../../domain/pipeline-report/analysisReport/index.js';
import { Pipeline } from '../../../domain/pipeline-report/pipeline/Pipeline.js';

describe('pipeline-report CLI module', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // 既存環境変数のAI系／API系を全て無効化して実行を予測可能にする
    delete process.env['AI_API_KEY'];
    delete process.env['AI_API_ENDPOINT_URL'];
    delete process.env['AI_MODEL_NAME'];
    delete process.env['AIKATA_API_URL'];
    delete process.env['AIKATA_JWT'];
    delete process.env['USER_ID'];
    delete process.env['GITLAB_PROJECT_ID'];
    delete process.env['GITLAB_PIPELINE_ID'];
    delete process.env['CI_PIPELINE_ID'];
    delete process.env['CI_JOB_ID'];
    delete process.env['GITLAB_SELF_JOB_ID'];
    delete process.env['AIKATA_PR_GITLAB_TOKEN'];
    delete process.env['PIPELINE_REPORT_SETTINGS_PATH'];
    delete process.env['PIPELINE_REPORT_RESULT_FILE'];
    delete process.env['MAX_CONTEXT_LENGTH'];
    delete process.env['OPENAI_REASONING_EFFORT'];
    delete process.env['CI_PROJECT_DIR'];
    delete process.env['AIKATA_PR_VERSION'];

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikata-pr-cli-test-'));
    resetLogger();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.env = originalEnv;
    resetLogger();
  });

  // ローカルモード: fake service を注入してanalyzeが呼ばれ、結果ファイルが書き込まれることを検証
  describe('ローカルモード', () => {
    it('analyze が呼ばれ結果が resultFile に書き込まれる', async () => {
      const resultFilePath = path.join(tmpDir, 'report.md');
      process.env['AI_API_KEY'] = 'k';
      process.env['AI_API_ENDPOINT_URL'] = 'https://ai.example.com';

      const fakeReport = AnalysisReport.of('# Pipeline Report\n\nall good');
      const fakePipeline = Pipeline.of({
        projectId: 10,
        pipelineId: 20,
        sha: 'abc',
        ref: 'main',
        status: 'success',
        webUrl: 'https://gitlab.example.com/pipelines/20',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:05:00Z'),
      });
      const fakeResult: PipelineAnalysisResult = {
        report: fakeReport,
        targetJobs: [],
        pipeline: fakePipeline,
        completenessVerified: true,
        completenessRetries: 0,
        workflowFailed: false,
        tokenStats: {
          compressed: false,
          folderTreeStripped: false,
          compressedJobIds: [],
        },
      };
      const analyze = vi.fn().mockResolvedValue(fakeResult);
      const cleanup = vi.fn();
      const localDeps: PipelineReportLocalDeps = {
        service: { analyze },
        cleanup,
      };

      await expect(
        run(
          [
            '--user-id',
            'alice',
            '--project-id',
            '10',
            '--pipeline-id',
            '20',
            '--aikata-pr-gitlab-token',
            'glt',
            '--result-file',
            resultFilePath,
          ],
          {
            localDepsFactory: () => localDeps,
          },
        ),
      ).resolves.toBeUndefined();

      expect(analyze).toHaveBeenCalledTimes(1);
      const cmd = analyze.mock.calls[0]![0];
      expect(cmd.userId).toBe('alice');
      expect(cmd.projectId).toBe(10);
      expect(cmd.pipelineId).toBe(20);
      // resultFilePath はサービス内部で生成されるためコマンドには含まれない

      // resultFile に書き込まれている
      expect(fs.readFileSync(resultFilePath, 'utf-8')).toBe('# Pipeline Report\n\nall good');
      // stdout にも出力されている
      expect(stdoutSpy).toHaveBeenCalled();
      const stdoutOut = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(stdoutOut).toContain('# Pipeline Report');
      // cleanup が呼ばれる
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('workflowFailed=true の場合、レポートを保存してから exit(1) する', async () => {
      const resultFilePath = path.join(tmpDir, 'partial-report.md');
      process.env['AI_API_KEY'] = 'k';
      process.env['AI_API_ENDPOINT_URL'] = 'https://ai.example.com';

      const fakeReport = AnalysisReport.of('# Partial Report\n\npartially done');
      const fakePipeline = Pipeline.of({
        projectId: 10,
        pipelineId: 20,
        sha: 'abc',
        ref: 'main',
        status: 'failed',
        webUrl: 'https://gitlab.example.com/pipelines/20',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:05:00Z'),
      });
      const fakeResult: PipelineAnalysisResult = {
        report: fakeReport,
        targetJobs: [],
        pipeline: fakePipeline,
        completenessVerified: false,
        completenessRetries: 0,
        workflowFailed: true,
        tokenStats: {
          compressed: false,
          folderTreeStripped: false,
          compressedJobIds: [],
        },
      };
      const analyze = vi.fn().mockResolvedValue(fakeResult);
      const cleanup = vi.fn();
      const localDeps: PipelineReportLocalDeps = {
        service: { analyze },
        cleanup,
      };

      await expect(
        run(
          [
            '--user-id',
            'alice',
            '--project-id',
            '10',
            '--pipeline-id',
            '20',
            '--aikata-pr-gitlab-token',
            'glt',
            '--result-file',
            resultFilePath,
          ],
          { localDepsFactory: () => localDeps },
        ),
      ).rejects.toThrow('process.exit:1');

      // レポートはファイルに保存されている
      expect(fs.readFileSync(resultFilePath, 'utf-8')).toBe('# Partial Report\n\npartially done');
      // stdout にも出力されている
      const stdoutOut = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(stdoutOut).toContain('# Partial Report');
      // cleanup が呼ばれる
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('service.analyze が失敗した場合、exit(1)し cleanupも呼ばれる', async () => {
      process.env['AI_API_KEY'] = 'k';
      process.env['AI_API_ENDPOINT_URL'] = 'https://ai.example.com';
      const analyze = vi.fn().mockRejectedValue(new Error('analysis failed'));
      const cleanup = vi.fn();
      const localDeps: PipelineReportLocalDeps = {
        service: { analyze },
        cleanup,
      };

      await expect(
        run(
          [
            '--user-id',
            'bob',
            '--project-id',
            '10',
            '--pipeline-id',
            '20',
            '--aikata-pr-gitlab-token',
            'glt',
            '--result-file',
            path.join(tmpDir, 'report.md'),
          ],
          { localDepsFactory: () => localDeps },
        ),
      ).rejects.toThrow('process.exit:1');

      expect(cleanup).toHaveBeenCalled();
    });
  });

  describe('APIモード', () => {
    beforeEach(() => {
      process.env['AIKATA_PR_VERSION'] = 'latest';
    });

    it('client.run が呼ばれ結果が resultFile に書き込まれる', async () => {
      const resultFilePath = path.join(tmpDir, 'api-report.md');
      const fakeApiResult: PipelineReportApiResult = {
        reportContent: '# API Pipeline Report\n\nok',
        completenessVerified: true,
        completenessRetries: 0,
        workflowFailed: false,
        targetJobIds: [1, 2],
        pipeline: {
          projectId: 10,
          pipelineId: 20,
          ref: 'main',
          sha: 'abc',
          status: 'success',
          webUrl: 'https://gitlab.example.com/pipelines/20',
        },
      };
      const clientRun = vi
        .fn<
          (
            req: Parameters<
              typeof import('../../../infrastructure/adapter/pipeline-report/apiClient/index.js').PipelineReportApiClient.prototype.run
            >[0],
            handlers: PipelineReportApiClientHandlers,
          ) => Promise<PipelineReportApiResult>
        >()
        .mockImplementation(async (_req, handlers) => {
          // progress と requestId の通知を模擬
          handlers.onJobIdReceived('req-xyz');
          handlers.onPoll({ attempt: 1, status: 200, bodyStatus: 'pending', elapsedMs: 0 });
          return fakeApiResult;
        });
      const apiDeps: PipelineReportApiDeps = {
        createClient: vi.fn().mockReturnValue({ run: clientRun }),
      };

      await expect(
        run(
          [
            '--user-id',
            'alice',
            '--project-id',
            '10',
            '--pipeline-id',
            '20',
            '--aikata-pr-gitlab-token',
            'glt',
            '--aikata-api-url',
            'https://api.example.com',
            '--result-file',
            resultFilePath,
          ],
          { apiDeps },
        ),
      ).resolves.toBeUndefined();

      expect(clientRun).toHaveBeenCalledTimes(1);
      const req = clientRun.mock.calls[0]![0];
      expect(req.userId).toBe('alice');
      expect(req.projectId).toBe(10);
      expect(req.pipelineId).toBe(20);

      expect(fs.readFileSync(resultFilePath, 'utf-8')).toBe('# API Pipeline Report\n\nok');
      const stdoutOut = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(stdoutOut).toContain('# API Pipeline Report');
    });

    it('workflowFailed=true の場合、レポートを保存してから exit(1) する', async () => {
      const resultFilePath = path.join(tmpDir, 'api-partial-report.md');
      const fakeApiResult: PipelineReportApiResult = {
        reportContent: '# API Partial Report\n\npartially analyzed',
        completenessVerified: false,
        completenessRetries: 0,
        workflowFailed: true,
        targetJobIds: [1],
        pipeline: {
          projectId: 10,
          pipelineId: 20,
          ref: 'main',
          sha: 'abc',
          status: 'failed',
          webUrl: 'https://gitlab.example.com/pipelines/20',
        },
      };
      const clientRun = vi
        .fn<
          (
            req: Parameters<
              typeof import('../../../infrastructure/adapter/pipeline-report/apiClient/index.js').PipelineReportApiClient.prototype.run
            >[0],
            handlers: PipelineReportApiClientHandlers,
          ) => Promise<PipelineReportApiResult>
        >()
        .mockImplementation(async (_req, handlers) => {
          handlers.onJobIdReceived('req-xyz');
          handlers.onPoll({ attempt: 1, status: 200, bodyStatus: 'pending', elapsedMs: 0 });
          return fakeApiResult;
        });
      const apiDeps: PipelineReportApiDeps = {
        createClient: vi.fn().mockReturnValue({ run: clientRun }),
      };

      await expect(
        run(
          [
            '--user-id',
            'alice',
            '--project-id',
            '10',
            '--pipeline-id',
            '20',
            '--aikata-pr-gitlab-token',
            'glt',
            '--aikata-api-url',
            'https://api.example.com',
            '--result-file',
            resultFilePath,
          ],
          { apiDeps },
        ),
      ).rejects.toThrow('process.exit:1');

      // レポートはファイルに保存されている
      expect(fs.readFileSync(resultFilePath, 'utf-8')).toBe(
        '# API Partial Report\n\npartially analyzed',
      );
      // stdout にも出力されている
      const stdoutOut = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(stdoutOut).toContain('# API Partial Report');
    });

    it('APIモードで client.run が失敗した場合 exit(1)', async () => {
      const clientRun = vi.fn().mockRejectedValue(new Error('API call failed'));
      const apiDeps: PipelineReportApiDeps = {
        createClient: vi.fn().mockReturnValue({ run: clientRun }),
      };

      await expect(
        run(
          [
            '--user-id',
            'alice',
            '--project-id',
            '10',
            '--pipeline-id',
            '20',
            '--aikata-pr-gitlab-token',
            'glt',
            '--aikata-api-url',
            'https://api.example.com',
            '--result-file',
            path.join(tmpDir, 'api-report.md'),
          ],
          { apiDeps },
        ),
      ).rejects.toThrow('process.exit:1');
    });
  });

  describe('エラーケース', () => {
    it('必須引数 --user-id 欠落で exit(1)', async () => {
      await expect(
        run([
          '--project-id',
          '10',
          '--pipeline-id',
          '20',
          '--aikata-pr-gitlab-token',
          'glt',
          '--aikata-api-url',
          'https://api.example.com',
        ]),
      ).rejects.toThrow('process.exit:1');
    });

    it('必須引数 --pipeline-id 欠落で exit(1)', async () => {
      await expect(
        run([
          '--user-id',
          'alice',
          '--project-id',
          '10',
          '--aikata-pr-gitlab-token',
          'glt',
          '--aikata-api-url',
          'https://api.example.com',
        ]),
      ).rejects.toThrow('process.exit:1');
    });

    it('ローカルモードで AI_API_ENDPOINT_URL も無い → APIモード判定 → aikata-api-url 必須エラー', async () => {
      await expect(
        run([
          '--user-id',
          'alice',
          '--project-id',
          '10',
          '--pipeline-id',
          '20',
          '--aikata-pr-gitlab-token',
          'glt',
        ]),
      ).rejects.toThrow('process.exit:1');
    });
  });

  describe('pipelineReportCliModule', () => {
    it('name と description を持つ CliFeatureModule を提供する', () => {
      expect(pipelineReportCliModule.name).toBe('pipeline-report');
      expect(typeof pipelineReportCliModule.description).toBe('string');
      expect(typeof pipelineReportCliModule.run).toBe('function');
    });
  });
});
