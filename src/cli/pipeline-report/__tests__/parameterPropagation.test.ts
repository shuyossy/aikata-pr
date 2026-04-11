import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../index.js';
import type { PipelineReportLocalDeps, PipelineReportApiDeps } from '../index.js';
import type {
  PipelineAnalysisResult,
  PipelineAnalyzeCommand,
} from '../../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import type { PipelineReportApiClientHandlers } from '../../../infrastructure/adapter/pipeline-report/apiClient/index.js';
import type { PipelineReportApiRequest } from '../../../infrastructure/adapter/pipeline-report/apiClient/index.js';
import type { PipelineReportApiResult } from '../../../infrastructure/adapter/pipeline-report/apiClient/index.js';
import { AnalysisReport } from '../../../domain/pipeline-report/analysisReport/index.js';
import { Pipeline } from '../../../domain/pipeline-report/pipeline/Pipeline.js';
import { Job } from '../../../domain/pipeline-report/job/Job.js';
import { resetLogger } from '../../../lib/logger.js';

/**
 * Phase 16: CLI → commandBuilder → PipelineAnalysisService (ローカルモード) /
 *          CLI → commandBuilder → PipelineReportApiClient (APIモード)
 * のパラメータ伝播を E2E で検証するテスト群。
 *
 * 既存の `index.test.ts` は「各モードで service/client が呼ばれること」までしか
 * 検証しておらず、jobReportFormat・additionalInstructions・includeJobPatterns・
 * commentLanguage・maxContextLength 等の非自明なフィールドが伝播しているかが
 * 検証されていない。Phase 16 では各フィールドがカスタム値として最終 DTO まで
 * 到達することを黒箱テストで保証する。
 *
 * 実装方針:
 * - 設定 JSON ファイルを一時ディレクトリに作成し、カスタム値で
 *   jobReportFormat / additionalInstructions / includeJobPatterns / excludeJobPatterns
 *   を指定する。
 * - CLI 引数と process.env を立て、`run()` を実行する。
 * - ローカルモードでは `localDepsFactory` に fake service を注入し、
 *   `analyze()` の引数として渡される PipelineAnalyzeCommand をキャプチャする。
 * - APIモードでは `apiDeps.createClient` に fake を注入し、`run()` の
 *   引数として渡される PipelineReportApiRequest をキャプチャする。
 */
describe('pipeline-report CLI パラメータ伝播 E2E', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  const CUSTOM_JOB_REPORT_FORMAT = '## ジョブ <jobName> (<status>)\nカスタムフォーマットです\n';
  const CUSTOM_ADDITIONAL_INSTRUCTIONS = 'カスタム追加指示: 必ず日本語で要約すること';
  const CUSTOM_INCLUDE_PATTERNS = ['^build:.*$', '^test:.*$'];
  const CUSTOM_EXCLUDE_PATTERNS = ['^skip:.*$'];

  beforeEach(() => {
    originalEnv = { ...process.env };
    // 予測可能性のため関連環境変数を全て削除
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
    delete process.env['PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES'];
    delete process.env['MAX_CONTEXT_LENGTH'];
    delete process.env['OPENAI_REASONING_EFFORT'];
    delete process.env['CI_PROJECT_DIR'];
    delete process.env['COMMENT_LANGUAGE'];
    delete process.env['SKILLS_PATH'];
    delete process.env['TREE_MAX_DEPTH'];

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikata-pr-propagation-'));
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

  /**
   * 設定 JSON ファイルを一時ディレクトリに作成する
   */
  function writeSettingsFile(): string {
    const settingsPath = path.join(tmpDir, 'pipeline-report-settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        jobReportFormat: CUSTOM_JOB_REPORT_FORMAT,
        additionalInstructions: CUSTOM_ADDITIONAL_INSTRUCTIONS,
        includeJobPatterns: CUSTOM_INCLUDE_PATTERNS,
        excludeJobPatterns: CUSTOM_EXCLUDE_PATTERNS,
      }),
    );
    return settingsPath;
  }

  describe('ローカルモード', () => {
    it('CLI 引数・設定ファイル・環境変数の全フィールドが PipelineAnalyzeCommand に伝播する', async () => {
      const settingsPath = writeSettingsFile();
      const resultFilePath = path.join(tmpDir, 'report.md');

      // ローカルモードに入るため AI 関連環境変数を設定
      process.env['AI_API_KEY'] = 'api-key-abc';
      process.env['AI_API_ENDPOINT_URL'] = 'https://ai.example.com/v1';
      process.env['MAX_CONTEXT_LENGTH'] = '12345';
      process.env['OPENAI_REASONING_EFFORT'] = 'high';
      process.env['CI_PROJECT_DIR'] = tmpDir;

      // fake service / fake pipeline
      const fakePipeline = Pipeline.of({
        projectId: 100,
        pipelineId: 200,
        sha: 'deadbeef',
        ref: 'main',
        status: 'success',
        webUrl: 'https://gitlab.example.com/pipelines/200',
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:10:00Z'),
      });
      const fakeResult: PipelineAnalysisResult = {
        report: AnalysisReport.of('# Pipeline Report\n\nok'),
        targetJobs: [],
        pipeline: fakePipeline,
        completenessVerified: true,
        completenessRetries: 0,
        tokenStats: {
          compressed: false,
          folderTreeStripped: false,
          compressedJobIds: [],
        },
      };

      let capturedCommand: PipelineAnalyzeCommand | undefined;
      const analyze = vi
        .fn<(command: PipelineAnalyzeCommand) => Promise<PipelineAnalysisResult>>()
        .mockImplementation(async (command) => {
          capturedCommand = command;
          return fakeResult;
        });
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
            '100',
            '--pipeline-id',
            '200',
            '--self-job-id',
            '999',
            '--aikata-pr-gitlab-token',
            'glpat-xyz',
            '--pipeline-report-settings',
            settingsPath,
            '--result-file',
            resultFilePath,
            '--comment-language',
            'Japanese',
            '--max-completeness-retries',
            '5',
            '--tree-max-depth',
            '3',
            '--skills',
            '.skills/custom',
            '--ai-model-name',
            'openai/o4-mini-custom',
          ],
          { localDepsFactory: () => localDeps },
        ),
      ).resolves.toBeUndefined();

      expect(analyze).toHaveBeenCalledTimes(1);
      expect(capturedCommand).toBeDefined();
      const cmd = capturedCommand!;

      // 基本フィールド
      expect(cmd.userId).toBe('alice');
      expect(cmd.projectId).toBe(100);
      expect(cmd.pipelineId).toBe(200);
      expect(cmd.selfJobId).toBe(999);
      expect(cmd.resultFilePath).toBe(resultFilePath);
      expect(cmd.projectDir).toBe(tmpDir);

      // 設定ファイル由来のフィールドが伝播している
      expect(cmd.settings.jobReportFormat).toBe(CUSTOM_JOB_REPORT_FORMAT);
      expect(cmd.settings.additionalInstructions).toBe(CUSTOM_ADDITIONAL_INSTRUCTIONS);
      expect(cmd.settings.includeJobPatterns.map((re) => re.source)).toEqual(
        CUSTOM_INCLUDE_PATTERNS,
      );
      expect(cmd.settings.excludeJobPatterns.map((re) => re.source)).toEqual(
        CUSTOM_EXCLUDE_PATTERNS,
      );

      // CLI フラグ由来のフィールド
      expect(cmd.commentLanguage).toBe('Japanese');
      expect(cmd.options.maxCompletenessRetries).toBe(5);
      expect(cmd.treeMaxDepth).toBe(3);
      expect(cmd.skillsPaths).toEqual(['.skills/custom']);

      // 環境変数由来のフィールド
      expect(cmd.maxContextLength).toBe(12345);
      expect(cmd.aiConfig.apiKey).toBe('api-key-abc');
      expect(cmd.aiConfig.endpointUrl).toBe('https://ai.example.com/v1');
      expect(cmd.aiConfig.modelName).toBe('openai/o4-mini-custom');
      expect(cmd.aiConfig.reasoningEffort).toBe('high');

      // onProgress コールバックが渡されている（型的には関数）
      expect(typeof cmd.onProgress).toBe('function');

      // cleanup が呼ばれている
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('PipelineReportSettings.filterJobs がパターンどおりに対象ジョブを絞り込む', async () => {
      // 設定ファイルのパターンが実際にドメインに伝播し、
      // filterJobs が期待通りに動くことを確認する
      const settingsPath = writeSettingsFile();
      process.env['AI_API_KEY'] = 'k';
      process.env['AI_API_ENDPOINT_URL'] = 'https://ai.example.com';

      let capturedCommand: PipelineAnalyzeCommand | undefined;
      const analyze = vi
        .fn<(command: PipelineAnalyzeCommand) => Promise<PipelineAnalysisResult>>()
        .mockImplementation(async (command) => {
          capturedCommand = command;
          return {
            report: AnalysisReport.of(''),
            targetJobs: [],
            pipeline: Pipeline.of({
              projectId: 10,
              pipelineId: 20,
              sha: 'x',
              ref: 'main',
              status: 'success',
              webUrl: 'https://gitlab.example.com/pipelines/20',
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
            completenessVerified: true,
            completenessRetries: 0,
            tokenStats: {
              compressed: false,
              folderTreeStripped: false,
              compressedJobIds: [],
            },
          };
        });
      const localDeps: PipelineReportLocalDeps = {
        service: { analyze },
        cleanup: () => {},
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
            '--pipeline-report-settings',
            settingsPath,
            '--result-file',
            path.join(tmpDir, 'report.md'),
          ],
          { localDepsFactory: () => localDeps },
        ),
      ).resolves.toBeUndefined();

      const settings = capturedCommand!.settings;

      // include: build:* / test:*, exclude: skip:*, selfJobId=999
      const makeJob = (id: number, name: string): Job =>
        Job.of({
          id,
          name,
          stage: 'test-stage',
          status: 'success',
          startedAt: null,
          finishedAt: null,
          duration: null,
          webUrl: `https://gitlab.example.com/jobs/${id}`,
          failureReason: null,
          hasArtifacts: false,
          artifactsSize: 0,
        });
      const jobs: Job[] = [
        makeJob(1, 'build:frontend'),
        makeJob(2, 'test:unit'),
        makeJob(3, 'deploy:staging'),
        makeJob(4, 'skip:manual'),
        makeJob(5, 'build:backend'),
        makeJob(999, 'build:self'), // selfJobId で除外
      ];

      const result = settings.filterJobs(jobs, 999);
      const resultIds = result.map((j) => j.id).sort((a, b) => a - b);
      // include で build:*, test:* が残り、skip:* は除外、selfJobId(999) は除外、deploy は include 非マッチで除外
      expect(resultIds).toEqual([1, 2, 5]);
    });

    it('--tree-max-depth 未指定時は undefined のまま伝播する（デフォルト動作）', async () => {
      process.env['AI_API_KEY'] = 'k';
      process.env['AI_API_ENDPOINT_URL'] = 'https://ai.example.com';

      let capturedCommand: PipelineAnalyzeCommand | undefined;
      const analyze = vi
        .fn<(command: PipelineAnalyzeCommand) => Promise<PipelineAnalysisResult>>()
        .mockImplementation(async (command) => {
          capturedCommand = command;
          return {
            report: AnalysisReport.of(''),
            targetJobs: [],
            pipeline: Pipeline.of({
              projectId: 10,
              pipelineId: 20,
              sha: 'x',
              ref: 'main',
              status: 'success',
              webUrl: 'https://gitlab.example.com/pipelines/20',
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
            completenessVerified: true,
            completenessRetries: 0,
            tokenStats: {
              compressed: false,
              folderTreeStripped: false,
              compressedJobIds: [],
            },
          };
        });
      const localDeps: PipelineReportLocalDeps = {
        service: { analyze },
        cleanup: () => {},
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
            path.join(tmpDir, 'r.md'),
          ],
          { localDepsFactory: () => localDeps },
        ),
      ).resolves.toBeUndefined();

      expect(capturedCommand!.treeMaxDepth).toBeUndefined();
      // skills 未指定時は空配列
      expect(capturedCommand!.skillsPaths).toEqual([]);
      // maxContextLength 未指定時は null
      expect(capturedCommand!.maxContextLength).toBeNull();
      // maxCompletenessRetries 未指定時は 3
      expect(capturedCommand!.options.maxCompletenessRetries).toBe(3);
      // OPENAI_REASONING_EFFORT 未指定時は null
      expect(capturedCommand!.aiConfig.reasoningEffort).toBeNull();
    });
  });

  describe('APIモード', () => {
    it('CLI 引数・設定ファイルの全フィールドが PipelineReportApiRequest に伝播する', async () => {
      const settingsPath = writeSettingsFile();
      const resultFilePath = path.join(tmpDir, 'api-report.md');

      // APIモードに入るため AI 系を未設定にし、AIKATA_JWT を設定
      process.env['AIKATA_JWT'] = 'jwt-token-xyz';
      process.env['MAX_CONTEXT_LENGTH'] = '54321';

      const fakeApiResult: PipelineReportApiResult = {
        reportContent: '# API Pipeline Report\n\nok',
        completenessVerified: true,
        completenessRetries: 0,
        targetJobIds: [1, 2],
        pipeline: {
          projectId: 100,
          pipelineId: 200,
          ref: 'main',
          sha: 'abc',
          status: 'success',
          webUrl: 'https://gitlab.example.com/pipelines/200',
        },
      };

      let capturedRequest: PipelineReportApiRequest | undefined;
      let capturedBaseUrl: string | undefined;
      let capturedJwt: string | null | undefined;
      const clientRun = vi
        .fn<
          (
            req: PipelineReportApiRequest,
            handlers: PipelineReportApiClientHandlers,
          ) => Promise<PipelineReportApiResult>
        >()
        .mockImplementation(async (req) => {
          capturedRequest = req;
          return fakeApiResult;
        });
      const apiDeps: PipelineReportApiDeps = {
        createClient: vi.fn().mockImplementation((config) => {
          capturedBaseUrl = config.baseUrl;
          capturedJwt = config.jwt;
          return { run: clientRun };
        }),
      };

      await expect(
        run(
          [
            '--user-id',
            'bob',
            '--project-id',
            '100',
            '--pipeline-id',
            '200',
            '--self-job-id',
            '888',
            '--aikata-pr-gitlab-token',
            'glpat-api',
            '--aikata-api-url',
            'https://aikata-api.example.com',
            '--pipeline-report-settings',
            settingsPath,
            '--result-file',
            resultFilePath,
            '--comment-language',
            'English',
            '--max-completeness-retries',
            '7',
            '--tree-max-depth',
            '4',
            '--skills',
            '.skills/api',
            '--ai-model-name',
            'openai/o4-mini-api',
          ],
          { apiDeps },
        ),
      ).resolves.toBeUndefined();

      // client 生成時の config が正しい
      expect(capturedBaseUrl).toBe('https://aikata-api.example.com');
      expect(capturedJwt).toBe('jwt-token-xyz');

      // run() への request 引数
      expect(capturedRequest).toBeDefined();
      const req = capturedRequest!;
      expect(req.userId).toBe('bob');
      expect(req.projectId).toBe(100);
      expect(req.pipelineId).toBe(200);
      expect(req.selfJobId).toBe(888);
      expect(req.gitlabToken).toBe('glpat-api');
      expect(req.aiModelName).toBe('openai/o4-mini-api');
      expect(req.commentLanguage).toBe('English');
      expect(req.maxContextLength).toBe(54321);
      expect(req.maxCompletenessRetries).toBe(7);
      expect(req.treeMaxDepth).toBe(4);
      expect(req.skillsRelPaths).toEqual(['.skills/api']);

      // 設定ファイル由来: RegExp は source 文字列として送信される
      expect(req.settings.jobReportFormat).toBe(CUSTOM_JOB_REPORT_FORMAT);
      expect(req.settings.additionalInstructions).toBe(CUSTOM_ADDITIONAL_INSTRUCTIONS);
      expect(req.settings.includeJobPatterns).toEqual(CUSTOM_INCLUDE_PATTERNS);
      expect(req.settings.excludeJobPatterns).toEqual(CUSTOM_EXCLUDE_PATTERNS);

      // 結果ファイルが書き込まれる
      expect(fs.readFileSync(resultFilePath, 'utf-8')).toBe('# API Pipeline Report\n\nok');
    });

    it('設定ファイル未指定時は PipelineReportSettings.default() が APIリクエストに伝播する', async () => {
      process.env['AIKATA_JWT'] = 'jwt';

      let capturedRequest: PipelineReportApiRequest | undefined;
      const apiDeps: PipelineReportApiDeps = {
        createClient: vi.fn().mockReturnValue({
          run: vi
            .fn<
              (
                req: PipelineReportApiRequest,
                handlers: PipelineReportApiClientHandlers,
              ) => Promise<PipelineReportApiResult>
            >()
            .mockImplementation(async (req) => {
              capturedRequest = req;
              return {
                reportContent: '',
                completenessVerified: true,
                completenessRetries: 0,
                targetJobIds: [],
                pipeline: {
                  projectId: 10,
                  pipelineId: 20,
                  ref: 'main',
                  sha: 'x',
                  status: 'success',
                  webUrl: 'https://gitlab.example.com/pipelines/20',
                },
              };
            }),
        }),
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
            path.join(tmpDir, 'r.md'),
          ],
          { apiDeps },
        ),
      ).resolves.toBeUndefined();

      expect(capturedRequest).toBeDefined();
      const req = capturedRequest!;
      // デフォルト値: default() の jobReportFormat は「ジョブ #<jobId>」を含むマークダウン
      expect(req.settings.jobReportFormat).toContain('<jobId>');
      expect(req.settings.jobReportFormat).toContain('<jobName>');
      expect(req.settings.additionalInstructions).toBeNull();
      expect(req.settings.includeJobPatterns).toEqual([]);
      expect(req.settings.excludeJobPatterns).toEqual([]);
      // デフォルト言語は Japanese
      expect(req.commentLanguage).toBe('Japanese');
      // デフォルト model は openai/o4-mini
      expect(req.aiModelName).toBe('openai/o4-mini');
      // デフォルト maxCompletenessRetries は 3
      expect(req.maxCompletenessRetries).toBe(3);
      // treeMaxDepth 未指定時は undefined
      expect(req.treeMaxDepth).toBeUndefined();
      // maxContextLength 未指定時は null
      expect(req.maxContextLength).toBeNull();
      // skills 未指定時は空配列
      expect(req.skillsRelPaths).toEqual([]);
    });
  });
});
