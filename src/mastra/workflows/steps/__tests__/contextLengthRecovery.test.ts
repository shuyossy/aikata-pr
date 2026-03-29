import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import type { Agent, MastraDBMessage, MastraMessagePart } from '@mastra/core/agent';
import { IndexedChecklist } from '../../../indexedCheckItem.js';
import type { IndexedCheckItem } from '../../../indexedCheckItem.js';
import type { ReviewAgentRequestContext } from '../../../requestContext.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';
import {
  serializeMessages,
  recoverFromContextLength,
  type ContextLengthRecoveryConfig,
} from '../contextLengthRecovery.js';

/**
 * テスト用のMastraDBMessageを生成するヘルパー
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

function createTestRequestContext(
  checkItems: IndexedCheckItem[] = new IndexedChecklist(['check1', 'check2']).items.slice(),
  resultFilePath: string = '',
): RequestContext<ReviewAgentRequestContext> {
  return new RequestContext<ReviewAgentRequestContext>([
    ['userId', 'test-user'],
    ['aiApiKey', 'test-key'],
    ['aiApiEndpointUrl', 'http://localhost'],
    ['aiModelName', 'test-model'],
    ['projectDir', '/test/project'],
    ['checkItems', checkItems],
    ['ratings', [{ label: 'A', definition: 'Good' }]],
    ['commentFormat', '{comment}'],
    ['additionalInstructions', ''],
    ['resultFilePath', resultFilePath],
    ['commentLanguage', 'Japanese'],
    ['mrTitle', 'Test MR'],
    ['mrDescription', 'Test'],
    ['mrSourceBranch', 'feature/test'],
    ['mrTargetBranch', 'main'],
    ['mrDiff', '+ line'],
    ['priorReviewContext', null],
    ['skillsPaths', []],
    ['folderTree', 'src/'],
  ]);
}

function createMockMemory() {
  return {
    recall: vi.fn().mockResolvedValue({ messages: [] }),
    deleteThread: vi.fn().mockResolvedValue(undefined),
  };
}

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
    const messages = [createMessage('user', 'Hello, please review')];

    const result = serializeMessages(messages);

    expect(result.text).toContain('[user]');
    expect(result.text).toContain('Hello, please review');
    expect(result.wasTrimmed).toBe(false);
  });

  it('assistantメッセージが正しくフォーマットされる', () => {
    const messages = [createMessage('assistant', 'I will review the code')];

    const result = serializeMessages(messages);

    expect(result.text).toContain('[assistant]');
    expect(result.text).toContain('I will review the code');
  });

  it('ツール呼び出しメッセージが正しくフォーマットされる', () => {
    const messages = [createToolMessage('storeReviewResult', 'stored successfully')];

    const result = serializeMessages(messages);

    expect(result.text).toContain('storeReviewResult');
  });

  it('複数メッセージが時系列順にフォーマットされる', () => {
    const messages = [
      createMessage('user', 'First message'),
      createMessage('assistant', 'Second message'),
      createMessage('user', 'Third message'),
    ];

    const result = serializeMessages(messages);

    const firstIdx = result.text.indexOf('First message');
    const secondIdx = result.text.indexOf('Second message');
    const thirdIdx = result.text.indexOf('Third message');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
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
    // 大量のメッセージを生成して上限を超過させる
    const longText = 'x'.repeat(1000);
    const messages = Array.from({ length: 100 }, (_, i) =>
      createMessage('user', `Message ${i}: ${longText}`),
    );

    const result = serializeMessages(messages, 50000); // 低い上限でテスト

    expect(result.wasTrimmed).toBe(true);
    // 先頭10%（10メッセージ）が含まれる
    expect(result.text).toContain('Message 0:');
    expect(result.text).toContain('Message 9:');
    // 末尾50%（50メッセージ）が含まれる
    expect(result.text).toContain('Message 50:');
    expect(result.text).toContain('Message 99:');
    // 中間部分はカットされている
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
  });

  it('200文字超のtool引数が切り詰められずに全文含まれる', () => {
    const longValue = 'a'.repeat(300);
    const message: MastraDBMessage = {
      id: 'msg-1',
      role: 'assistant',
      createdAt: new Date(),
      content: {
        format: 2 as const,
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'storeReviewResult',
              state: 'result' as const,
              toolCallId: 'call-1',
              args: { longParam: longValue },
              result: 'ok',
            },
          } as MastraMessagePart,
        ],
      },
    };

    const result = serializeMessages([message]);

    // 300文字のvalueが全て含まれること
    expect(result.text).toContain(longValue);
  });

  it('500文字超のtool結果が切り詰められずに全文含まれる', () => {
    const longResult = 'b'.repeat(800);
    const message: MastraDBMessage = {
      id: 'msg-1',
      role: 'assistant',
      createdAt: new Date(),
      content: {
        format: 2 as const,
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'storeReviewResult',
              state: 'result' as const,
              toolCallId: 'call-1',
              args: { param: 'value' },
              result: longResult,
            },
          } as MastraMessagePart,
        ],
      },
    };

    const result = serializeMessages([message]);

    // 800文字のresultが全て含まれること
    expect(result.text).toContain(longResult);
  });

  it('text・tool-invocation以外のパートタイプは無視される', () => {
    const message: MastraDBMessage = {
      id: 'msg-1',
      role: 'assistant',
      createdAt: new Date(),
      content: {
        format: 2 as const,
        parts: [
          { type: 'text', text: 'Some text' } as MastraMessagePart,
          { type: 'step-start' } as MastraMessagePart,
          { type: 'reasoning', reasoning: 'thinking...' } as MastraMessagePart,
        ],
      },
    };

    const result = serializeMessages([message]);

    expect(result.text).toContain('Some text');
    expect(result.text).not.toContain('thinking');
    expect(result.text).not.toContain('step-start');
  });
});

describe('recoverFromContextLength', () => {
  let tmpDir: string;
  let resultFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-recovery-test-'));
    resultFilePath = path.join(tmpDir, 'results.json');
    vi.clearAllMocks();
    initializeLogger({ userId: 'test-user', level: 'silent' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetLogger();
  });

  it('memory.recall → 要約agent呼び出し → memory.deleteThread の順序で実行される', async () => {
    const callOrder: string[] = [];

    const mockMemory = {
      recall: vi.fn().mockImplementation(async () => {
        callOrder.push('recall');
        return {
          messages: [createMessage('user', 'Review the code')],
        };
      }),
      deleteThread: vi.fn().mockImplementation(async () => {
        callOrder.push('deleteThread');
      }),
    };

    const reviewAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callOrder.push('summarize');
        return { text: 'Summary of work' };
      }),
    );

    const config: ContextLengthRecoveryConfig = {
      reviewAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(
        new IndexedChecklist(['check1']).items.slice(),
        resultFilePath,
      ),
      checkItems: new IndexedChecklist(['check1']).items.slice(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await recoverFromContextLength(config);

    expect(callOrder).toEqual(['recall', 'summarize', 'deleteThread']);
  });

  it('リカバリー成功時: 新しいthreadIdとsummaryが返される', async () => {
    const mockMemory = {
      recall: vi.fn().mockResolvedValue({
        messages: [createMessage('user', 'Review')],
      }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    };

    const reviewAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(
      vi.fn().mockResolvedValue({ text: 'Summary: reviewed security items' }),
    );

    const config: ContextLengthRecoveryConfig = {
      reviewAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(
        new IndexedChecklist(['check1']).items.slice(),
        resultFilePath,
      ),
      checkItems: new IndexedChecklist(['check1']).items.slice(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const result = await recoverFromContextLength(config);

    expect(result.newThreadId).toBeDefined();
    expect(result.newThreadId).toHaveLength(36); // UUID
    expect(result.newThreadId).not.toBe('old-thread-id');
    expect(result.summary).toBe('Summary: reviewed security items');
  });

  it('要約agent失敗時: エラーがスローされる', async () => {
    const mockMemory = {
      recall: vi.fn().mockResolvedValue({
        messages: [createMessage('user', 'Review')],
      }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    };

    const reviewAgent = createMockAgent(vi.fn(), mockMemory);
    const summarizationAgent = createMockAgent(
      vi.fn().mockRejectedValue(new Error('Summarization failed')),
    );

    const config: ContextLengthRecoveryConfig = {
      reviewAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(
        new IndexedChecklist(['check1']).items.slice(),
        resultFilePath,
      ),
      checkItems: new IndexedChecklist(['check1']).items.slice(),
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await expect(recoverFromContextLength(config)).rejects.toThrow('Summarization failed');
  });

  it('レビュー済み結果がある場合、要約agentのRequestContextに含まれる', async () => {
    // 結果ファイルにレビュー済み結果を書き込む
    fs.writeFileSync(
      resultFilePath,
      JSON.stringify([
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Good',
          comment: 'No issues',
          isError: false,
        },
      ]),
    );

    const mockMemory = {
      recall: vi.fn().mockResolvedValue({
        messages: [createMessage('user', 'Review')],
      }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
    };

    const reviewAgent = createMockAgent(vi.fn(), mockMemory);

    const generateFn = vi.fn().mockResolvedValue({ text: 'Summary' });
    const summarizationAgent = createMockAgent(generateFn);

    const checkItems = new IndexedChecklist(['check1', 'check2']).items.slice();
    const config: ContextLengthRecoveryConfig = {
      reviewAgent,
      summarizationAgent,
      threadId: 'old-thread-id',
      resourceId: 'test-user',
      requestContext: createTestRequestContext(checkItems, resultFilePath),
      checkItems,
      rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    await recoverFromContextLength(config);

    // 要約agentのgenerate呼び出しでRequestContextにレビュー済み情報が含まれる
    const callOptions = generateFn.mock.calls[0][1];
    const ctx = callOptions.requestContext.all;
    expect(ctx.alreadyStoredSummary).toContain('[ID: 1]');
    expect(ctx.alreadyStoredSummary).toContain('check1');
  });
});
