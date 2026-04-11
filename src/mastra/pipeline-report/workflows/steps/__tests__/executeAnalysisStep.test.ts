import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APICallError } from 'ai';
import { RequestContext } from '@mastra/core/request-context';
import type { Agent, MastraDBMessage } from '@mastra/core/agent';
import type { PipelineAnalysisAgentRequestContext } from '../../../requestContext.js';
import type { TargetJobSummary } from '../../../types.js';
import { initializeLogger, resetLogger } from '../../../../../lib/logger.js';
import { RateLimiter } from '../../../../../infrastructure/adapter/rateLimiter/RateLimiter.js';
import { initializeRateLimiter, resetRateLimiter } from '../../../../../lib/rateLimiterGlobal.js';
import {
  executeAnalysisStep,
  type ExecuteAnalysisStepConfig,
  MAX_CONTEXT_LENGTH_RECOVERIES,
  buildContinuationPrompt,
} from '../executeAnalysisStep.js';

/**
 * テスト用の RequestContext を生成するヘルパー
 */
function createTestRequestContext(
  overrides: Partial<PipelineAnalysisAgentRequestContext> = {},
): RequestContext<PipelineAnalysisAgentRequestContext> {
  const targetJobs: TargetJobSummary[] = overrides.targetJobs ?? [
    { id: 101, name: 'build', stage: 'build', status: 'success', duration: 42 },
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
    overallTemplate: '# Pipeline Report\n{{job-sections}}',
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

/**
 * テスト用のモック Memory を作成するヘルパー
 */
function createMockMemory(messages: MastraDBMessage[] = []) {
  return {
    recall: vi.fn().mockResolvedValue({ messages }),
    deleteThread: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * テスト用のモック Agent を作成するヘルパー
 */
function createMockAgent(
  generateFn: (...args: unknown[]) => Promise<unknown>,
  mockMemory = createMockMemory(),
): Agent {
  return {
    generate: generateFn,
    getMemory: vi.fn().mockResolvedValue(mockMemory),
  } as unknown as Agent;
}

/**
 * コンテキスト長エラーを模擬する APICallError を生成
 */
function createContextLengthError(): APICallError {
  return new APICallError({
    message: 'Context length exceeded',
    url: 'http://test-api/v1/chat',
    requestBodyValues: {},
    statusCode: 400,
    responseBody: 'context_length_exceeded',
    isRetryable: false,
  });
}

describe('buildContinuationPrompt', () => {
  it('要約テキストと継続指示が含まれる', () => {
    const result = buildContinuationPrompt('Summary: analyzed build and test jobs so far.');

    expect(result).toContain('Context Length Recovery Notice');
    expect(result).toContain('Summary: analyzed build and test jobs so far.');
    expect(result).toContain('Continue analyzing the remaining target jobs');
    expect(result).toContain('get-report');
  });
});

describe('executeAnalysisStep', () => {
  let tmpDir: string;
  let resultFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-analysis-test-'));
    resultFilePath = path.join(tmpDir, 'pipeline-report.md');
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

  it('正常系: 初期テンプレート書き込み → generate呼び出し → レポート内容を返却', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });

    // Agent の generate 内で write-report tool を使ったかのように resultFilePath を上書き
    const generateFn = vi.fn().mockImplementation(async () => {
      await fs.promises.writeFile(
        resultFilePath,
        '# Pipeline Report\n\n## Summary\nAll 1 jobs analyzed.',
        'utf8',
      );
    });
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      initialUserPrompt: 'Analyze the pipeline',
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(result.reportContent).toBe('# Pipeline Report\n\n## Summary\nAll 1 jobs analyzed.');
    expect(result.contextLengthRecoveries).toBe(0);
    // 最初の呼び出しでは initialUserPrompt が渡されている
    expect(generateFn.mock.calls[0][0]).toBe('Analyze the pipeline');
  });

  it('初期テンプレートが overallTemplate で書き込まれる', async () => {
    const requestContext = createTestRequestContext({
      resultFilePath,
      overallTemplate: '## SKELETON\n{{job-sections}}',
    });

    // generate 呼び出しの時点で resultFilePath が存在することを確認する
    const generateFn = vi.fn().mockImplementation(async () => {
      const content = await fs.promises.readFile(resultFilePath, 'utf8');
      expect(content).toBe('## SKELETON\n{{job-sections}}');
    });
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      initialUserPrompt: 'Analyze',
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalled();
    // 最後まで agent が書き戻さなければ初期テンプレートがそのまま残る
    expect(result.reportContent).toBe('## SKELETON\n{{job-sections}}');
  });

  it('context length エラー1回 → リカバリー → リトライ成功', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });

    let call = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        throw createContextLengthError();
      }
      await fs.promises.writeFile(resultFilePath, 'final report', 'utf8');
    });
    const memoryWithMessages = createMockMemory([
      {
        id: 'm1',
        role: 'user',
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [{ type: 'text', text: 'Analyze' } as never],
        },
      },
    ]);
    const analysisAgent = createMockAgent(generateFn, memoryWithMessages);
    const summarizationAgent = createMockAgent(
      vi.fn().mockResolvedValue({ text: 'partial summary' }),
    );

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      initialUserPrompt: 'Analyze the pipeline',
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalledTimes(2);
    expect(result.reportContent).toBe('final report');
    expect(result.contextLengthRecoveries).toBe(1);

    // 2 回目の呼び出しは継続プロンプトが渡される
    const secondPrompt = generateFn.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('Context Length Recovery Notice');
    expect(secondPrompt).toContain('partial summary');
  });

  it('context length エラー上限到達時は現状のレポートを返す（throwしない）', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });

    const generateFn = vi.fn().mockImplementation(async () => {
      // 常にコンテキスト長エラー
      throw createContextLengthError();
    });
    const memoryWithMessages = createMockMemory([
      {
        id: 'm1',
        role: 'user',
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [{ type: 'text', text: 'Analyze' } as never],
        },
      },
    ]);
    const analysisAgent = createMockAgent(generateFn, memoryWithMessages);
    const summarizationAgent = createMockAgent(vi.fn().mockResolvedValue({ text: 'summary' }));

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      initialUserPrompt: 'Analyze',
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await executeAnalysisStep(config);

    // 初回 + MAX_CONTEXT_LENGTH_RECOVERIES 回のリトライ = 計 4 回
    expect(generateFn).toHaveBeenCalledTimes(MAX_CONTEXT_LENGTH_RECOVERIES + 1);
    expect(result.contextLengthRecoveries).toBe(MAX_CONTEXT_LENGTH_RECOVERIES);
    // 初期テンプレートのまま（リカバリー中は write されていない）
    expect(result.reportContent).toBe('# Pipeline Report\n{{job-sections}}');
  });

  it('非コンテキスト長エラーは呼び出し元に再スローされる', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });

    const generateFn = vi.fn().mockRejectedValue(new Error('Unknown agent failure'));
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      initialUserPrompt: 'Analyze',
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await expect(executeAnalysisStep(config)).rejects.toThrow('Unknown agent failure');
  });

  it('extraGenerateOptions が generate にマージされて渡される', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });

    const generateFn = vi.fn().mockResolvedValue(undefined);
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const prepareStepSentinel = vi.fn();
    const toolsetsSentinel = { foo: { tools: {} } };

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      initialUserPrompt: 'Analyze',
      extraGenerateOptions: {
        prepareStep: prepareStepSentinel,
        toolsets: toolsetsSentinel,
        maxSteps: 50,
      },
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalledTimes(1);
    const opts = generateFn.mock.calls[0][1] as {
      prepareStep: unknown;
      toolsets: unknown;
      maxSteps: number;
      requestContext: RequestContext;
      memory: { thread: string; resource: string };
    };
    expect(opts.prepareStep).toBe(prepareStepSentinel);
    expect(opts.toolsets).toBe(toolsetsSentinel);
    expect(opts.maxSteps).toBe(50);
    expect(opts.requestContext).toBe(requestContext);
    expect(opts.memory.resource).toBe('test-user');
    expect(typeof opts.memory.thread).toBe('string');
  });
});
