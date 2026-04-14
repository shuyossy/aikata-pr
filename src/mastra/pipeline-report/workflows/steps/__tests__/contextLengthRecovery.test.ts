import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import type { Agent, MastraDBMessage, MastraMessagePart } from '@mastra/core/agent';
import type { PipelineAnalysisAgentRequestContext } from '../../../requestContext.js';
import type { TargetJobSummary } from '../../../types.js';
import { initializeLogger, resetLogger } from '../../../../../lib/logger.js';
import { RateLimiter } from '../../../../../infrastructure/adapter/rateLimiter/RateLimiter.js';
import { initializeRateLimiter, resetRateLimiter } from '../../../../../lib/rateLimiterGlobal.js';
import {
  serializeMessages,
  recoverFromContextLength,
  type PipelineReportContextLengthRecoveryConfig,
} from '../contextLengthRecovery.js';

/**
 * テスト用の MastraDBMessage を生成するヘルパー
 */
function createMessage(
  role: 'user' | 'assistant' | 'system',
  textContent: string,
  id?: string,
): MastraDBMessage {
  return {
    id: id ?? `msg-${Math.random().toString(36).slice(2)}`,
    role,
    createdAt: new Date(),
    content: {
      format: 2 as const,
      parts: [{ type: 'text', text: textContent } as MastraMessagePart],
    },
  };
}

/**
 * テスト用のツール呼び出しメッセージを生成するヘルパー
 */
function createToolMessage(toolName: string, result: string): MastraDBMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: 'assistant' as const,
    createdAt: new Date(),
    content: {
      format: 2 as const,
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: {
            toolName,
            state: 'result' as const,
            toolCallId: `call-${Math.random().toString(36).slice(2)}`,
            args: { param: 'value' },
            result,
          },
        } as MastraMessagePart,
      ],
    },
  };
}

/**
 * prepareStep で注入される画像付きuserメッセージを生成するヘルパー
 */
function createImageUserMessage(
  images: Array<{ filePath: string; base64Data: string; mediaType: string }>,
): MastraDBMessage {
  const fileList = images.map((img, i) => `${i + 1}. ${img.filePath}`).join('\n');
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: 'user' as const,
    createdAt: new Date(),
    content: {
      format: 2 as const,
      parts: [
        {
          type: 'text' as const,
          text:
            `The readImage tool was used to retrieve the following ${images.length} image(s). ` +
            `Each image is displayed in the order listed below. ` +
            `Please continue your analysis using these images.\n\n` +
            fileList,
        },
        ...images.map((img) => ({
          type: 'file' as const,
          mimeType: img.mediaType,
          data: img.base64Data,
        })),
      ],
    },
  };
}

/**
 * テスト用の PipelineAnalysisAgentRequestContext を生成するヘルパー
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
    overallTemplate: '# Report\n{{job-sections}}',
    jobReportFormat: '### Job <jobId>',
    additionalInstructions: null,
    commentLanguage: 'Japanese',
    resultFilePath: '/tmp/report.md',
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

/**
 * テスト用のモック Memory を作成するヘルパー
 */
function createMockMemory() {
  return {
    recall: vi.fn().mockResolvedValue({ messages: [] }),
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

describe('serializeMessages', () => {
  it('userメッセージが正しくフォーマットされる', () => {
    const messages = [createMessage('user', 'Please analyze the pipeline')];

    const result = serializeMessages(messages);

    expect(result.text).toContain('[user]');
    expect(result.text).toContain('Please analyze the pipeline');
    expect(result.wasTrimmed).toBe(false);
  });

  it('assistantメッセージが正しくフォーマットされる', () => {
    const messages = [createMessage('assistant', 'I will analyze each job')];

    const result = serializeMessages(messages);

    expect(result.text).toContain('[assistant]');
    expect(result.text).toContain('I will analyze each job');
  });

  it('ツール呼び出しメッセージが正しくフォーマットされる', () => {
    const messages = [createToolMessage('write-report', 'report written')];

    const result = serializeMessages(messages);

    expect(result.text).toContain('write-report');
    expect(result.text).toContain('report written');
  });

  it('上限以内の場合は全メッセージが保持される', () => {
    const messages = [
      createMessage('user', 'Short message 1'),
      createMessage('assistant', 'Short message 2'),
    ];

    const result = serializeMessages(messages);

    expect(result.wasTrimmed).toBe(false);
    expect(result.text).toContain('Short message 1');
    expect(result.text).toContain('Short message 2');
  });

  it('上限超過時に古い10%＋新しい50%が保持され、中間がカットされる', () => {
    const longText = 'x'.repeat(1000);
    const messages = Array.from({ length: 100 }, (_, i) =>
      createMessage('user', `Message ${i}: ${longText}`),
    );

    const result = serializeMessages(messages, 50000);

    expect(result.wasTrimmed).toBe(true);
    expect(result.text).toContain('Message 0:');
    expect(result.text).toContain('Message 9:');
    expect(result.text).toContain('Message 50:');
    expect(result.text).toContain('Message 99:');
    expect(result.text).not.toContain('Message 20:');
    expect(result.text).not.toContain('Message 40:');
  });

  it('カット時にカットされた旨の注記が含まれる', () => {
    const longText = 'x'.repeat(1000);
    const messages = Array.from({ length: 100 }, (_, i) =>
      createMessage('user', `Message ${i}: ${longText}`),
    );

    const result = serializeMessages(messages, 50000);

    expect(result.wasTrimmed).toBe(true);
    expect(result.text).toContain('messages from the middle of the conversation were omitted');
  });

  it('空のメッセージ配列は空文字列を返す', () => {
    const result = serializeMessages([]);

    expect(result.text).toBe('');
    expect(result.wasTrimmed).toBe(false);
    expect(result.imageData).toHaveLength(0);
  });

  it('画像付きuserメッセージから画像データを抽出し、プレースホルダーに置換する', () => {
    const messages = [
      createImageUserMessage([
        { filePath: 'screenshots/ui.png', base64Data: 'AAAA', mediaType: 'image/png' },
      ]),
    ];

    const result = serializeMessages(messages);

    expect(result.text).toContain('[Image: screenshots/ui.png]');
    expect(result.text).not.toContain('AAAA');
    expect(result.imageData).toHaveLength(1);
    expect(result.imageData[0]).toEqual({
      filePath: 'screenshots/ui.png',
      base64Data: 'AAAA',
      mediaType: 'image/png',
    });
  });

  it('通常のuserメッセージは画像抽出されない', () => {
    const messages = [createMessage('user', 'Review the logs')];

    const result = serializeMessages(messages);

    expect(result.text).toContain('Review the logs');
    expect(result.imageData).toHaveLength(0);
  });

  it('複数画像を含むuserメッセージから全ての画像データを抽出する', () => {
    const messages = [
      createImageUserMessage([
        { filePath: 'a.png', base64Data: 'data1', mediaType: 'image/png' },
        { filePath: 'b.jpg', base64Data: 'data2', mediaType: 'image/jpeg' },
      ]),
    ];

    const result = serializeMessages(messages);

    expect(result.imageData).toHaveLength(2);
    expect(result.text).toContain('[Image: a.png]');
    expect(result.text).toContain('[Image: b.jpg]');
  });
});

describe('recoverFromContextLength', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeLogger({ userId: 'test-user', level: 'silent' });
    resetRateLimiter();
    const limiter = new RateLimiter({ rateLimitPerMin: 100 });
    initializeRateLimiter(limiter);
    limiter.registerProject('1234');
  });

  afterEach(() => {
    resetLogger();
    resetRateLimiter();
  });

  it('memory.recall → 要約agent呼び出し → memory.deleteThread の順序で実行される', async () => {
    const callOrder: string[] = [];

    const mockMemory = {
      recall: vi.fn().mockImplementation(async () => {
        callOrder.push('recall');
        return {
          messages: [createMessage('user', 'Analyze the pipeline')],
        };
      }),
      deleteThread: vi.fn().mockImplementation(async () => {
        callOrder.push('deleteThread');
      }),
    };

    const analysisAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callOrder.push('summarize');
        return { text: 'Summary of analysis progress' };
      }),
    );

    const config: PipelineReportContextLengthRecoveryConfig = {
      analysisAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await recoverFromContextLength(config);

    expect(callOrder).toEqual(['recall', 'summarize', 'deleteThread']);
  });

  it('リカバリー成功時: 新しいthreadIdとsummaryが返される', async () => {
    const mockMemory = {
      recall: vi.fn().mockResolvedValue({
        messages: [createMessage('user', 'Analyze')],
      }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    };

    const analysisAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(
      vi.fn().mockResolvedValue({ text: 'Summary: analyzed 2 out of 5 jobs' }),
    );

    const config: PipelineReportContextLengthRecoveryConfig = {
      analysisAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await recoverFromContextLength(config);

    expect(result.newThreadId).toBeDefined();
    expect(result.newThreadId).toHaveLength(36);
    expect(result.newThreadId).not.toBe('old-thread-id');
    expect(result.summary).toBe('Summary: analyzed 2 out of 5 jobs');
  });

  it('要約agent失敗時: エラーがスローされる', async () => {
    const mockMemory = {
      recall: vi.fn().mockResolvedValue({
        messages: [createMessage('user', 'Analyze')],
      }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    };

    const analysisAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(
      vi.fn().mockRejectedValue(new Error('Summarization failed')),
    );

    const config: PipelineReportContextLengthRecoveryConfig = {
      analysisAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await expect(recoverFromContextLength(config)).rejects.toThrow('Summarization failed');
  });

  it('要約agentに targetJobs が渡されている', async () => {
    const targetJobs: TargetJobSummary[] = [
      { id: 10, name: 'lint', stage: 'check', status: 'success', duration: 12 },
      { id: 20, name: 'test', stage: 'test', status: 'failed', duration: 60 },
    ];
    const mockMemory = {
      recall: vi.fn().mockResolvedValue({
        messages: [createMessage('user', 'Analyze')],
      }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    };

    const capturedOptions: Array<{ requestContext: RequestContext }> = [];
    const analysisAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(
      vi.fn().mockImplementation(async (_prompt: unknown, options: unknown) => {
        capturedOptions.push(options as { requestContext: RequestContext });
        return { text: 'Summary' };
      }),
    );

    const config: PipelineReportContextLengthRecoveryConfig = {
      analysisAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext({ targetJobs }),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await recoverFromContextLength(config);

    expect(capturedOptions).toHaveLength(1);
    const passedJobs = capturedOptions[0].requestContext.get('targetJobs') as TargetJobSummary[];
    expect(passedJobs).toHaveLength(2);
    expect(passedJobs[0].id).toBe(10);
    expect(passedJobs[1].id).toBe(20);
  });

  it('スレッド削除失敗時も処理は成功扱いでリカバリー結果が返る', async () => {
    const mockMemory = {
      recall: vi.fn().mockResolvedValue({
        messages: [createMessage('user', 'Analyze')],
      }),
      deleteThread: vi.fn().mockRejectedValue(new Error('delete failed')),
    };

    const analysisAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(vi.fn().mockResolvedValue({ text: 'Summary' }));

    const config: PipelineReportContextLengthRecoveryConfig = {
      analysisAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await recoverFromContextLength(config);

    expect(result.summary).toBe('Summary');
    expect(result.newThreadId).toHaveLength(36);
  });

  it('Memory が null の場合もエラーにならず summary を返す', async () => {
    const analysisAgent = {
      getMemory: vi.fn().mockResolvedValue(null),
    } as unknown as Agent;
    const summarizationAgent = createMockAgent(vi.fn().mockResolvedValue({ text: 'Summary' }));

    const config: PipelineReportContextLengthRecoveryConfig = {
      analysisAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await recoverFromContextLength(config);

    expect(result.summary).toBe('Summary');
  });
});
