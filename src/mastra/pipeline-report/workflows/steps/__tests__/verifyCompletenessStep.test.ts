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
  buildFeedbackWithReportPrompt,
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

describe('buildFeedbackWithReportPrompt', () => {
  it('レポート現物とフィードバックの両方が含まれる', () => {
    const reportContent = '# Report\n## Job 101\nBuild succeeded.';
    const feedbackPrompt = '## Completeness Review Feedback\nJob #102 is missing.';

    const result = buildFeedbackWithReportPrompt(reportContent, feedbackPrompt);

    expect(result).toContain('Current Report Progress');
    expect(result).toContain('# Report\n## Job 101\nBuild succeeded.');
    expect(result).toContain('## Completeness Review Feedback');
    expect(result).toContain('Job #102 is missing.');
  });

  it('レポート現物が markdown コードブロック内に含まれる', () => {
    const result = buildFeedbackWithReportPrompt('report text', 'feedback');

    expect(result).toContain('```markdown');
    expect(result).toContain('report text');
    expect(result).toContain('```');
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

  it('isComplete=true の場合、完了で feedbackPrompt=null を返す', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        isComplete: true,
        missingItems: [],
        formatDeviations: [],
      },
    });

    const config: VerifyCompletenessStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.isComplete).toBe(true);
    expect(result.feedbackPrompt).toBeNull();
    expect(result.reportContent).toBe('# Report\n(initial)');
    expect(result.lastJudgement?.isComplete).toBe(true);
    expect(judgeGenerate).toHaveBeenCalledTimes(1);
  });

  it('isComplete=false の場合、feedbackPrompt を構築して返す', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        isComplete: false,
        missingItems: [
          { jobId: 102, jobName: 'test', reason: 'job block missing from the report' },
        ],
        formatDeviations: [],
      },
    });

    const config: VerifyCompletenessStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.isComplete).toBe(false);
    expect(result.feedbackPrompt).toContain('Completeness Review Feedback');
    expect(result.feedbackPrompt).toContain('#102 `test`');
    expect(result.lastJudgement?.missingItems).toHaveLength(1);
    expect(judgeGenerate).toHaveBeenCalledTimes(1);
  });

  it('judge agent が JSON エラーになった場合は warning で isComplete=false, feedbackPrompt=null を返す', async () => {
    const judgeGenerate = vi.fn().mockRejectedValue(new Error('invalid json'));

    const config: VerifyCompletenessStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.isComplete).toBe(false);
    expect(result.feedbackPrompt).toBeNull();
    expect(result.lastJudgement).toBeNull();
    expect(result.reportContent).toBe('# Report\n(initial)');
  });

  it('structuredOutput が object を返さず text で返す場合も JSON パースで判定できる', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        isComplete: true,
        missingItems: [],
        formatDeviations: [],
      }),
    });

    const config: VerifyCompletenessStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await verifyCompletenessStep(config);

    expect(result.isComplete).toBe(true);
    expect(result.feedbackPrompt).toBeNull();
  });

  it('buildGenerateOptions 経由で reasoningEffort が judge agent に渡される', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: { isComplete: true, missingItems: [], formatDeviations: [] },
    });

    const config: VerifyCompletenessStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      requestContext: createTestRequestContext({
        resultFilePath,
        aiConfig: {
          apiKey: 'test-key',
          endpointUrl: 'http://localhost',
          modelName: 'test-model',
          reasoningEffort: 'medium',
        },
      }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await verifyCompletenessStep(config);

    const opts = judgeGenerate.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.modelSettings).toEqual({ temperature: 1 });
    expect(opts.providerOptions).toEqual({ openai: { reasoningEffort: 'medium' } });
  });
});
