import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  buildRateLimitContinuationPrompt,
  getLastRateLimitContinuationMessageId,
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
    projectId: '1234',
    pipelineId: 9999,
    projectDir: '/test/project',
    aiApiKey: 'test-key',
    aiApiEndpointUrl: 'http://localhost',
    aiModelName: 'test-model',
    openaiReasoningEffort: undefined,
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
  it('初期ユーザプロンプト・レポート現物・要約テキスト・継続指示が含まれる', () => {
    const result = buildContinuationPrompt(
      'Analyze pipeline #123 with jobs: build, test',
      '# Report\n## Job 101\nAnalysis done.',
      'Summary: analyzed build job so far.',
      null,
    );

    expect(result).toContain('Analyze pipeline #123 with jobs: build, test');
    expect(result).toContain('Current Report Progress');
    expect(result).toContain('# Report\n## Job 101\nAnalysis done.');
    expect(result).toContain('Context Length Recovery Notice');
    expect(result).toContain('Summary: analyzed build job so far.');
    expect(result).toContain('Continue analyzing the remaining target jobs');
  });

  it('feedbackPrompt が指定されている場合、プロンプト末尾に含まれる', () => {
    const result = buildContinuationPrompt(
      'Initial prompt',
      'Report content',
      'Summary text',
      '## Completeness Review Feedback\nJob #102 is missing.',
    );

    expect(result).toContain('Initial prompt');
    expect(result).toContain('Report content');
    expect(result).toContain('Summary text');
    expect(result).toContain('## Completeness Review Feedback');
    expect(result).toContain('Job #102 is missing.');
  });

  it('feedbackPrompt が null の場合、フィードバックセクションが含まれない', () => {
    const result = buildContinuationPrompt(
      'Initial prompt',
      'Report content',
      'Summary text',
      null,
    );

    expect(result).not.toContain('Completeness Review Feedback');
  });
});

describe('executeAnalysisStep', () => {
  let tmpDir: string;
  let resultFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-analysis-test-'));
    resultFilePath = path.join(tmpDir, 'pipeline-report.md');
    // テンプレートを事前に書き込む（prepare step の責務）
    fs.writeFileSync(resultFilePath, '# Pipeline Report\n{{job-sections}}', 'utf8');
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

  it('正常系: generate呼び出し → レポート内容を返却', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

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
      currentPrompt: 'Analyze the pipeline',
      threadId,
      initialUserPromptForRecovery: 'Analyze the pipeline',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(result.reportContent).toBe('# Pipeline Report\n\n## Summary\nAll 1 jobs analyzed.');
    expect(result.contextLengthRecoveries).toBe(0);
    expect(result.finalThreadId).toBe(threadId);
    // 最初の呼び出しでは currentPrompt が渡されている
    expect(generateFn.mock.calls[0][0]).toBe('Analyze the pipeline');
  });

  it('呼び出し元から渡された threadId を使用する', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = 'custom-thread-id-123';

    const generateFn = vi.fn().mockResolvedValue(undefined);
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze',
      threadId,
      initialUserPromptForRecovery: 'Analyze',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await executeAnalysisStep(config);

    expect(result.finalThreadId).toBe(threadId);
    const opts = generateFn.mock.calls[0][1] as {
      memory: { thread: string; resource: string };
    };
    expect(opts.memory.thread).toBe(threadId);
  });

  it('context length エラー1回 → リカバリー → リトライ成功', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

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
      currentPrompt: 'Analyze the pipeline',
      threadId,
      initialUserPromptForRecovery: 'Analyze the pipeline',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalledTimes(2);
    expect(result.reportContent).toBe('final report');
    expect(result.contextLengthRecoveries).toBe(1);

    // 2 回目の呼び出しは continuation prompt
    const secondPrompt = generateFn.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('Context Length Recovery Notice');
    expect(secondPrompt).toContain('partial summary');
    // 初期ユーザプロンプトが先頭に含まれる（review 同パターン）
    expect(secondPrompt).toContain('Analyze the pipeline');
    // レポート現物が含まれる
    expect(secondPrompt).toContain('Current Report Progress');
  });

  it('context length recovery 時にレポート現物が continuation prompt に含まれる', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

    let call = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        // 1回目のgenerate でレポートを部分的に更新
        await fs.promises.writeFile(
          resultFilePath,
          '# Report\n## Job 101\nBuild succeeded.',
          'utf8',
        );
        throw createContextLengthError();
      }
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
      vi.fn().mockResolvedValue({ text: 'analyzed job 101' }),
    );

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze pipeline with build and test jobs',
      threadId,
      initialUserPromptForRecovery: 'Analyze pipeline with build and test jobs',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await executeAnalysisStep(config);

    const secondPrompt = generateFn.mock.calls[1][0] as string;
    // レポート現物が continuation prompt に含まれる
    expect(secondPrompt).toContain('# Report\n## Job 101\nBuild succeeded.');
    // 初期ユーザプロンプトが先頭にある
    expect(secondPrompt.indexOf('Analyze pipeline with build and test jobs')).toBe(0);
  });

  it('feedback 再実行中の context length recovery で feedbackPrompt が含まれる', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

    let call = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        throw createContextLengthError();
      }
    });
    const memoryWithMessages = createMockMemory([
      {
        id: 'm1',
        role: 'user',
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [{ type: 'text', text: 'Feedback' } as never],
        },
      },
    ]);
    const analysisAgent = createMockAgent(generateFn, memoryWithMessages);
    const summarizationAgent = createMockAgent(vi.fn().mockResolvedValue({ text: 'summary' }));

    const feedbackText = '## Completeness Review Feedback\nJob #102 missing';
    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: feedbackText,
      threadId,
      initialUserPromptForRecovery: 'Initial pipeline prompt',
      feedbackPromptForRecovery: feedbackText,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await executeAnalysisStep(config);

    const secondPrompt = generateFn.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('Initial pipeline prompt');
    expect(secondPrompt).toContain('## Completeness Review Feedback');
    expect(secondPrompt).toContain('Job #102 missing');
  });

  it('context length エラー上限到達時は現状のレポートを返す（throwしない）', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

    const generateFn = vi.fn().mockImplementation(async () => {
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
      currentPrompt: 'Analyze',
      threadId,
      initialUserPromptForRecovery: 'Analyze',
      feedbackPromptForRecovery: null,
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
    const threadId = randomUUID();

    const generateFn = vi.fn().mockRejectedValue(new Error('Unknown agent failure'));
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze',
      threadId,
      initialUserPromptForRecovery: 'Analyze',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await expect(executeAnalysisStep(config)).rejects.toThrow('Unknown agent failure');
  });

  it('extraGenerateOptions が generate にマージされて渡される', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

    const generateFn = vi.fn().mockResolvedValue(undefined);
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const prepareStepSentinel = vi.fn();
    const toolsetsSentinel = { foo: { tools: {} } };

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze',
      threadId,
      initialUserPromptForRecovery: 'Analyze',
      feedbackPromptForRecovery: null,
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
    expect(opts.memory.thread).toBe(threadId);
  });

  it('reasoningEffort が設定されている場合、generate オプションに含まれる', async () => {
    const requestContext = createTestRequestContext({
      resultFilePath,
      openaiReasoningEffort: 'high',
    });
    const threadId = randomUUID();

    const generateFn = vi.fn().mockResolvedValue(undefined);
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze',
      threadId,
      initialUserPromptForRecovery: 'Analyze',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await executeAnalysisStep(config);

    const opts = generateFn.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.modelSettings).toEqual({ temperature: 1 });
    expect(opts.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('レート制限時に onRateLimitHit で継続プロンプトに差し替わる', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

    const rateLimitError = new APICallError({
      message: 'Rate limit exceeded',
      url: 'http://test-api/v1/chat',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: 'rate limit exceeded',
      isRetryable: true,
    });

    let call = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        throw rateLimitError;
      }
      // 2回目は成功
    });
    const analysisAgent = createMockAgent(generateFn);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze the pipeline',
      threadId,
      initialUserPromptForRecovery: 'Analyze the pipeline',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalledTimes(2);
    // 2回目の呼び出しは継続プロンプト
    const secondPrompt = generateFn.mock.calls[1][0] as string;
    expect(secondPrompt).toBe(buildRateLimitContinuationPrompt());
  });

  it('連続レート制限時にメモリの重複継続プロンプトが削除される', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

    const rateLimitError = new APICallError({
      message: 'Rate limit exceeded',
      url: 'http://test-api/v1/chat',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: 'rate limit exceeded',
      isRetryable: true,
    });

    let call = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) {
        throw rateLimitError;
      }
      // 3回目は成功
    });
    // 2回目のレート制限時、メモリには前回の継続プロンプトが積まれている
    const mockMemory = createMockMemory();
    // 1回目のonRateLimitHitではメッセージなし→削除不要
    // 2回目のonRateLimitHitでは前回の継続プロンプトが末尾にある→削除
    let recallCallCount = 0;
    mockMemory.recall.mockImplementation(async () => {
      recallCallCount++;
      if (recallCallCount === 1) {
        return { messages: [] };
      }
      // 2回目: 前回の継続プロンプトが末尾にある
      return {
        messages: [
          {
            id: 'dup-msg-1',
            role: 'user',
            createdAt: new Date(),
            content: {
              format: 2 as const,
              parts: [{ type: 'text', text: buildRateLimitContinuationPrompt() } as never],
            },
          },
        ],
      };
    });
    const deleteMessagesFn = vi.fn().mockResolvedValue(undefined);
    (mockMemory as unknown as { deleteMessages: typeof deleteMessagesFn }).deleteMessages =
      deleteMessagesFn;
    const analysisAgent = createMockAgent(generateFn, mockMemory);
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze the pipeline',
      threadId,
      initialUserPromptForRecovery: 'Analyze the pipeline',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await executeAnalysisStep(config);

    expect(generateFn).toHaveBeenCalledTimes(3);
    // 2回目の onRateLimitHit で重複メッセージが削除された
    expect(deleteMessagesFn).toHaveBeenCalledWith(['dup-msg-1']);
  });

  it('onRateLimitHit内のメモリ操作失敗時にエラーが握りつぶされる', async () => {
    const requestContext = createTestRequestContext({ resultFilePath });
    const threadId = randomUUID();

    const rateLimitError = new APICallError({
      message: 'Rate limit exceeded',
      url: 'http://test-api/v1/chat',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: 'rate limit exceeded',
      isRetryable: true,
    });

    let call = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        throw rateLimitError;
      }
    });
    // getMemory が例外をスローするケース
    const analysisAgent = {
      generate: generateFn,
      getMemory: vi.fn().mockRejectedValue(new Error('Memory unavailable')),
    } as unknown as Agent;
    const summarizationAgent = createMockAgent(vi.fn());

    const config: ExecuteAnalysisStepConfig = {
      analysisAgent,
      summarizationAgent,
      requestContext,
      currentPrompt: 'Analyze the pipeline',
      threadId,
      initialUserPromptForRecovery: 'Analyze the pipeline',
      feedbackPromptForRecovery: null,
      rateLimitRetryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
    };

    // エラーが握りつぶされて正常終了する
    await executeAnalysisStep(config);
    expect(generateFn).toHaveBeenCalledTimes(2);
  });
});

describe('buildRateLimitContinuationPrompt', () => {
  it('レート制限リカバリー通知と継続指示を含む', () => {
    const prompt = buildRateLimitContinuationPrompt();
    expect(prompt).toContain('Rate Limit Recovery Notice');
    expect(prompt).toContain('conversation history is preserved');
    expect(prompt).toContain('resume analyzing the remaining target jobs');
    expect(prompt).toContain('patch-report');
  });
});

describe('getLastRateLimitContinuationMessageId', () => {
  it('空配列の場合はnullを返す', () => {
    expect(getLastRateLimitContinuationMessageId([])).toBeNull();
  });

  it('末尾がassistantメッセージの場合はnullを返す', () => {
    const messages: MastraDBMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [{ type: 'text', text: buildRateLimitContinuationPrompt() } as never],
        },
      },
    ];
    expect(getLastRateLimitContinuationMessageId(messages)).toBeNull();
  });

  it('末尾がuserメッセージだが継続プロンプトと一致しない場合はnullを返す', () => {
    const messages: MastraDBMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [{ type: 'text', text: 'Some other message' } as never],
        },
      },
    ];
    expect(getLastRateLimitContinuationMessageId(messages)).toBeNull();
  });

  it('末尾がuserメッセージで継続プロンプトと一致する場合はIDを返す', () => {
    const messages: MastraDBMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [{ type: 'text', text: buildRateLimitContinuationPrompt() } as never],
        },
      },
    ];
    expect(getLastRateLimitContinuationMessageId(messages)).toBe('msg-1');
  });

  it('content.content フォールバックでもテキストを抽出できる', () => {
    const messages: MastraDBMessage[] = [
      {
        id: 'msg-fallback',
        role: 'user',
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [],
          content: buildRateLimitContinuationPrompt(),
        },
      },
    ];
    expect(getLastRateLimitContinuationMessageId(messages)).toBe('msg-fallback');
  });
});
