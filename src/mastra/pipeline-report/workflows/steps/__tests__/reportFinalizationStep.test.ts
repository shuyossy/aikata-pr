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
  reportFinalizationStep,
  buildMissingJobsFeedbackPrompt,
  buildFeedbackWithReportPrompt,
  type ReportFinalizationStepConfig,
  type ReportFinalizationJudgement,
} from '../reportFinalizationStep.js';

function createTestRequestContext(
  overrides: Partial<PipelineAnalysisAgentRequestContext> = {},
): RequestContext<PipelineAnalysisAgentRequestContext> {
  const targetJobs: TargetJobSummary[] = overrides.targetJobs ?? [
    { id: 101, name: 'build', stage: 'build', status: 'success', duration: 42 },
    { id: 102, name: 'test', stage: 'test', status: 'failed', duration: 120 },
  ];
  const all: PipelineAnalysisAgentRequestContext = {
    userId: 'test-user',
    projectId: '1234',
    pipelineId: 9999,
    projectDir: '/test/project',
    aiApiKey: 'test-key',
    aiApiEndpointUrl: 'http://localhost',
    aiModelName: 'test-model',
    openaiReasoningEffort: undefined,
    targetJobs,
    overallTemplate: '# Report\n{{job-sections}}',
    jobReportFormat: '### Job <jobId>',
    analysisInstructions: null,
    reportRefinementInstructions: null,
    commentLanguage: 'Japanese',
    resultFilePath: '',
    skillsPaths: [],
    folderTree: 'src/',
    folderTreeStripped: false,
    omittedJobLogs: new Map(),
    artifactCachePaths: new Map(),
    artifactArchiveReader: {
      listEntries: async () => [],
      readFile: async () => ({ data: Buffer.from(''), truncated: false }),
    },
    hasImages: false,
    pendingImages: [],
    reportLockTimeoutMs: undefined,
    workspaceAvailable: false,
    mergedYaml: null,
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

describe('buildMissingJobsFeedbackPrompt', () => {
  it('missingJobReasons が含まれる場合、各理由がリスト化される', () => {
    const judgement: ReportFinalizationJudgement = {
      hasMissingJobs: true,
      missingJobReasons: [
        "Job #1 'build' has no block in the report",
        "Job #2 'test' has no block in the report",
      ],
      finalizationNeeded: false,
      finalizationActions: [],
    };

    const result = buildMissingJobsFeedbackPrompt(judgement);

    expect(result).toContain('Completeness Review Feedback');
    expect(result).toContain('Missing Jobs');
    expect(result).toContain("Job #1 'build'");
    expect(result).toContain("Job #2 'test'");
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

describe('reportFinalizationStep', () => {
  let tmpDir: string;
  let resultFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-finalization-test-'));
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

  it('judge agentに2つのuserメッセージが渡される', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        hasMissingJobs: false,
        missingJobReasons: [],
        finalizationNeeded: false,
        finalizationActions: [],
      },
    });
    const rewriteGenerate = vi.fn();

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await reportFinalizationStep(config);

    const prompt = judgeGenerate.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(Array.isArray(prompt)).toBe(true);
    expect(prompt).toHaveLength(2);
    expect(prompt[0].role).toBe('user');
    expect(prompt[1].role).toBe('user');
    expect(prompt[0].content).toContain('Target Jobs');
    expect(prompt[1].content).toContain('Current Report Contents');
  });

  it('hasMissingJobs=false, finalizationNeeded=false → isComplete=true, finalizationApplied=false', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        hasMissingJobs: false,
        missingJobReasons: [],
        finalizationNeeded: false,
        finalizationActions: [],
      },
    });
    const rewriteGenerate = vi.fn();

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await reportFinalizationStep(config);

    expect(result.isComplete).toBe(true);
    expect(result.hasMissingJobs).toBe(false);
    expect(result.feedbackPrompt).toBeNull();
    expect(result.finalizationApplied).toBe(false);
    expect(result.reportContent).toBe('# Report\n(initial)');
    expect(rewriteGenerate).not.toHaveBeenCalled();
  });

  it('hasMissingJobs=true → isComplete=false, feedbackPrompt を返す', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        hasMissingJobs: true,
        missingJobReasons: ["Job #102 'test' has no block in the report"],
        finalizationNeeded: false,
        finalizationActions: [],
      },
    });
    const rewriteGenerate = vi.fn();

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await reportFinalizationStep(config);

    expect(result.isComplete).toBe(false);
    expect(result.hasMissingJobs).toBe(true);
    expect(result.feedbackPrompt).toContain('Completeness Review Feedback');
    expect(result.feedbackPrompt).toContain("Job #102 'test'");
    expect(result.finalizationApplied).toBe(false);
    expect(rewriteGenerate).not.toHaveBeenCalled();
  });

  it('finalizationNeeded=true, hasMissingJobs=false → rewrite agent 呼び出し、ファイル書き込み、isComplete=true', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        hasMissingJobs: false,
        missingJobReasons: [],
        finalizationNeeded: true,
        finalizationActions: ['Job sections are not ordered by assessment severity'],
      },
    });
    const rewrittenContent = '# Report\n(rewritten by rewrite agent)';
    const rewriteGenerate = vi.fn().mockResolvedValue({
      text: rewrittenContent,
    });

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await reportFinalizationStep(config);

    expect(result.isComplete).toBe(true);
    expect(result.hasMissingJobs).toBe(false);
    expect(result.feedbackPrompt).toBeNull();
    expect(result.finalizationApplied).toBe(true);
    expect(result.reportContent).toBe(rewrittenContent);
    // ファイルにも書き込まれていること
    expect(fs.readFileSync(resultFilePath, 'utf8')).toBe(rewrittenContent);
    expect(rewriteGenerate).toHaveBeenCalledTimes(1);
  });

  it('rewrite agent のプロンプトに finalizationActions と現レポートが含まれる', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        hasMissingJobs: false,
        missingJobReasons: [],
        finalizationNeeded: true,
        finalizationActions: ['Fix sort order'],
      },
    });
    const rewriteGenerate = vi.fn().mockResolvedValue({ text: '# Rewritten' });

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({
        resultFilePath,
        reportRefinementInstructions: '問題なしジョブを非表示',
      }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await reportFinalizationStep(config);

    const prompt = rewriteGenerate.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(prompt[0].content).toContain('Fix sort order');
    expect(prompt[0].content).toContain('# Report\n(initial)');
    expect(prompt[0].content).toContain('問題なしジョブを非表示');
  });

  it('judge agent がエラーになった場合は isComplete=false, feedbackPrompt=null を返す', async () => {
    const judgeGenerate = vi.fn().mockRejectedValue(new Error('invalid json'));
    const rewriteGenerate = vi.fn();

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await reportFinalizationStep(config);

    expect(result.isComplete).toBe(false);
    expect(result.hasMissingJobs).toBe(false);
    expect(result.feedbackPrompt).toBeNull();
    expect(result.finalizationApplied).toBe(false);
    expect(result.lastJudgement).toBeNull();
    expect(rewriteGenerate).not.toHaveBeenCalled();
  });

  it('rewrite agent がエラーになった場合は isComplete=false, finalizationApplied=false を返す', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        hasMissingJobs: false,
        missingJobReasons: [],
        finalizationNeeded: true,
        finalizationActions: ['Fix sort order'],
      },
    });
    const rewriteGenerate = vi.fn().mockRejectedValue(new Error('rewrite failed'));

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await reportFinalizationStep(config);

    expect(result.isComplete).toBe(false);
    expect(result.hasMissingJobs).toBe(false);
    expect(result.feedbackPrompt).toBeNull();
    expect(result.finalizationApplied).toBe(false);
    expect(result.lastJudgement?.finalizationNeeded).toBe(true);
    // ファイルは元のまま
    expect(fs.readFileSync(resultFilePath, 'utf8')).toBe('# Report\n(initial)');
  });

  it('structuredOutput が object を返さず text で返す場合も JSON パースで判定できる', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        hasMissingJobs: false,
        missingJobReasons: [],
        finalizationNeeded: false,
        finalizationActions: [],
      }),
    });
    const rewriteGenerate = vi.fn();

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({ resultFilePath }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await reportFinalizationStep(config);

    expect(result.isComplete).toBe(true);
    expect(result.feedbackPrompt).toBeNull();
  });

  it('buildGenerateOptions 経由で reasoningEffort が judge agent に渡される', async () => {
    const judgeGenerate = vi.fn().mockResolvedValue({
      object: {
        hasMissingJobs: false,
        missingJobReasons: [],
        finalizationNeeded: false,
        finalizationActions: [],
      },
    });
    const rewriteGenerate = vi.fn();

    const config: ReportFinalizationStepConfig = {
      judgeAgent: createMockAgent(judgeGenerate),
      rewriteAgent: createMockAgent(rewriteGenerate),
      requestContext: createTestRequestContext({
        resultFilePath,
        openaiReasoningEffort: 'medium',
      }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await reportFinalizationStep(config);

    const opts = judgeGenerate.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.modelSettings).toEqual({ temperature: 1 });
    expect(opts.providerOptions).toEqual({ openai: { reasoningEffort: 'medium' } });
  });
});
