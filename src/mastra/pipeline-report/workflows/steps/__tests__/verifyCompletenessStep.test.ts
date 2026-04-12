import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import type { Agent } from '@mastra/core/agent';
import type { PipelineAnalysisAgentRequestContext } from '../../../requestContext.js';
import type { TargetJobSummary } from '../../../types.js';
import { initializeLogger, resetLogger } from '../../../../../lib/logger.js';
import { RateLimiter } from '../../../../../infrastructure/adapter/rateLimiter/RateLimiter.js';
import { initializeRateLimiter, resetRateLimiter } from '../../../../../lib/rateLimiterGlobal.js';
import {
  verifyCompletenessStep,
  buildCompletenessFeedbackPrompt,
  type VerifyCompletenessStepConfig,
  type ReportCompletenessJudgement,
} from '../verifyCompletenessStep.js';

function createTestRequestContext(
  overrides: Partial<PipelineAnalysisAgentRequestContext> = {},
): RequestContext<PipelineAnalysisAgentRequestContext> {
  const targetJobs: TargetJobSummary[] = overrides.targetJobs ?? [
    { id: 101, name: 'build', stage: 'build', status: 'success', duration: 42 },
    { id: 102, name: 'test', stage: 'test', status: 'failed', duration: 120 },
  ];
  const all: PipelineAnalysisAgentRequestContext = {
    userId: 'test-user',
    projectId: 1234,
    pipelineId: 9999,
    projectDir: '/test/project',
    aiConfig: {
      apiKey: 'test-key',
      endpointUrl: 'http://localhost',
      modelName: 'test-model',
      reasoningEffort: null,
    },
    targetJobs,
    overallTemplate: '# Report\n{{job-sections}}',
    jobReportFormat: '### Job <jobId>',
    additionalInstructions: null,
    commentLanguage: 'Japanese',
    resultFilePath: '',
    skillsPaths: [],
    folderTree: 'src/',
    folderTreeStripped: false,
    omittedJobLogs: new Map(),
    artifactCachePaths: new Map(),
    hasImages: false,
    pendingImages: new Map(),
    reportLockTimeoutMs: undefined,
    workspaceAvailable: false,
    ...overrides,
  };
  const entries = Object.entries(all) as Array<
    [keyof PipelineAnalysisAgentRequestContext, unknown]
  >;
  return new RequestContext<PipelineAnalysisAgentRequestContext>(
    entries.map(([k, v]) => [k, v]) as ConstructorParameters<
      typeof RequestContext<PipelineAnalysisAgentRequestContext>
    >[0],
  );
}

function createMockAgent(generateFn: (...args: unknown[]) => Promise<unknown>): Agent {
  return {
    generate: generateFn,
    getMemory: vi.fn().mockResolvedValue({
      recall: vi.fn().mockResolvedValue({ messages: [] }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Agent;
}

describe('buildCompletenessFeedbackPrompt', () => {
  it('missingItems が含まれる場合、ジョブ情報と理由がリスト化される', () => {
    const judgement: ReportCompletenessJudgement = {
      isComplete: false,
      missingItems: [
        { jobId: 1, jobName: 'build', reason: 'job block missing from the report' },
        { jobId: 2, jobName: 'test', reason: '<duration> placeholder not resolved' },
      ],
      formatDeviations: [],
    };

    const result = buildCompletenessFeedbackPrompt(judgement);

    expect(result).toContain('Completeness Review Feedback');
    expect(result).toContain('Missing Job Blocks');
    expect(result).toContain('#1 `build`');
    expect(result).toContain('#2 `test`');
    expect(result).toContain('<duration> placeholder');
    expect(result).toContain('patch-report');
  });

  it('formatDeviations が含まれる場合、各項目がリスト化される', () => {
    const judgement: ReportCompletenessJudgement = {
      isComplete: false,
      missingItems: [],
      formatDeviations: [
        "job #42 'test-e2e' uses unexpected AI rating value 'Maybe'",
        'job #1 omits the Evidence section',
      ],
    };

    const result = buildCompletenessFeedbackPrompt(judgement);

    expect(result).toContain('Format Deviations');
    expect(result).toContain("'Maybe'");
    expect(result).toContain('omits the Evidence section');
  });
});

describe('verifyCompletenessStep', () => {
  let tmpDir: string;
  let resultFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-complete-test-'));
    resultFilePath = path.join(tmpDir, 'pipeline-report.md');
    fs.writeFileSync(resultFilePath, '# Report\n(initial)', 'utf8');
    vi.clearAllMocks();
    initializeLogger({ userId: 'test-user', level: 'silent' });
    resetRateLimiter();
    const limiter = new RateLimiter({ rateLimitPerMin: 100 });
    initializeRateLimiter(limiter);
    limiter.registerProject('1234');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetLogger();
    resetRateLimiter();
  });

  it('isComplete=true で即座に完了する（analysis agent は呼ばれない）', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        isComplete: true,
        missingItems: [],
        formatDeviations: [],
      },
    });
    const analysisGenerate = vi.fn();

    const config: VerifyCompletenessStepConfig = {
      analysisAgent: createMockAgent(analysisGenerate),
      judgeAgent: createMockAgent(judgeGenerate),
      summarizationAgent: createMockAgent(vi.fn()),
      requestContext: createTestRequestContext({ resultFilePath }),
      threadId: 'thread-1',
      maxCompletenessRetries: 3,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.completenessVerified).toBe(true);
    expect(result.completenessRetries).toBe(0);
    expect(result.reportContent).toBe('# Report\n(initial)');
    expect(judgeGenerate).toHaveBeenCalledTimes(1);
    expect(analysisGenerate).not.toHaveBeenCalled();
  });

  it('1 回 isComplete=false → analysis再実行 → 2 回目で isComplete=true', async () => {
    let judgeCall = 0;
    const judgeGenerate = vi.fn().mockImplementation(async () => {
      judgeCall++;
      if (judgeCall === 1) {
        return {
          object: {
            isComplete: false,
            missingItems: [
              { jobId: 102, jobName: 'test', reason: 'job block missing from the report' },
            ],
            formatDeviations: [],
          },
        };
      }
      return {
        object: {
          isComplete: true,
          missingItems: [],
          formatDeviations: [],
        },
      };
    });
    const analysisGenerate = vi.fn().mockImplementation(async () => {
      // 分析agentが新たにジョブブロックを書き込んだ体で report を更新
      await fs.promises.writeFile(resultFilePath, '# Report\n### Job 102', 'utf8');
    });

    const config: VerifyCompletenessStepConfig = {
      analysisAgent: createMockAgent(analysisGenerate),
      judgeAgent: createMockAgent(judgeGenerate),
      summarizationAgent: createMockAgent(vi.fn()),
      requestContext: createTestRequestContext({ resultFilePath }),
      threadId: 'thread-1',
      maxCompletenessRetries: 3,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.completenessVerified).toBe(true);
    expect(result.completenessRetries).toBe(1);
    expect(result.reportContent).toBe('# Report\n### Job 102');
    expect(judgeGenerate).toHaveBeenCalledTimes(2);
    expect(analysisGenerate).toHaveBeenCalledTimes(1);

    // analysis agent に渡されたプロンプトにフィードバックが含まれる
    const analysisPrompt = analysisGenerate.mock.calls[0][0] as string;
    expect(analysisPrompt).toContain('Completeness Review Feedback');
    expect(analysisPrompt).toContain('#102 `test`');
  });

  it('maxCompletenessRetries 上限到達時は completenessVerified=false で終了', async () => {
    // 常に isComplete=false を返す
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        isComplete: false,
        missingItems: [{ jobId: 102, jobName: 'test', reason: 'still missing' }],
        formatDeviations: [],
      },
    });
    const analysisGenerate = vi.fn().mockResolvedValue(undefined);

    const maxCompletenessRetries = 2;
    const config: VerifyCompletenessStepConfig = {
      analysisAgent: createMockAgent(analysisGenerate),
      judgeAgent: createMockAgent(judgeGenerate),
      summarizationAgent: createMockAgent(vi.fn()),
      requestContext: createTestRequestContext({ resultFilePath }),
      threadId: 'thread-1',
      maxCompletenessRetries,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.completenessVerified).toBe(false);
    expect(result.completenessRetries).toBe(maxCompletenessRetries);
    // judge は maxCompletenessRetries + 1 回呼ばれる（各サイクルと最終判定）
    expect(judgeGenerate).toHaveBeenCalledTimes(maxCompletenessRetries + 1);
    expect(analysisGenerate).toHaveBeenCalledTimes(maxCompletenessRetries);
    expect(result.lastJudgement).toBeTruthy();
    expect(result.lastJudgement?.missingItems).toHaveLength(1);
  });

  it('judge agent が JSON エラーになった場合は warning ログで現状を返す', async () => {
    const judgeGenerate = vi.fn().mockRejectedValue(new Error('invalid json'));
    const analysisGenerate = vi.fn();

    const config: VerifyCompletenessStepConfig = {
      analysisAgent: createMockAgent(analysisGenerate),
      judgeAgent: createMockAgent(judgeGenerate),
      summarizationAgent: createMockAgent(vi.fn()),
      requestContext: createTestRequestContext({ resultFilePath }),
      threadId: 'thread-1',
      maxCompletenessRetries: 3,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.completenessVerified).toBe(false);
    expect(result.completenessRetries).toBe(0);
    expect(result.lastJudgement).toBeNull();
    expect(result.reportContent).toBe('# Report\n(initial)');
    expect(analysisGenerate).not.toHaveBeenCalled();
  });

  it('structuredOutput が object を返さず text で返す場合も JSON パースで判定できる', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      // object なし、text 経由
      text: JSON.stringify({
        isComplete: true,
        missingItems: [],
        formatDeviations: [],
      }),
    });
    const analysisGenerate = vi.fn();

    const config: VerifyCompletenessStepConfig = {
      analysisAgent: createMockAgent(analysisGenerate),
      judgeAgent: createMockAgent(judgeGenerate),
      summarizationAgent: createMockAgent(vi.fn()),
      requestContext: createTestRequestContext({ resultFilePath }),
      threadId: 'thread-1',
      maxCompletenessRetries: 3,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.completenessVerified).toBe(true);
    expect(result.completenessRetries).toBe(0);
  });
});
