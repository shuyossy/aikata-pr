import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { APICallError } from 'ai';
import { IndexedChecklist } from '../../../indexedCheckItem.js';
import type { IndexedCheckItem } from '../../../indexedCheckItem.js';
import {
  executeReview,
  type ReviewExecutionConfig,
  buildRateLimitContinuationPrompt,
} from '../reviewExecution.js';
import type { Agent } from '@mastra/core/agent';
import type { ReviewAgentRequestContext } from '../../../requestContext.js';
import { DEFAULT_RATE_LIMIT_RETRY_CONFIG } from '../../../../lib/rateLimitRetry.js';
import { UNEXPECTED_ERROR_MESSAGE } from '../../../../lib/errorClassifier.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';

/**
 * 結果ファイルにレビュー結果を書き込むヘルパー
 * Agent の storeReviewResult ツール呼び出しをシミュレートする（ID方式）
 */
function writeResultsToFile(
  filePath: string,
  results: Array<{
    checkItemId: number;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError: boolean;
    errorMessage?: string;
  }>,
): void {
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');
}

/**
 * テスト用のRequestContextを作成するヘルパー
 */
function createTestRequestContext(
  checkItems: IndexedCheckItem[] = new IndexedChecklist([
    'security check',
    'performance check',
  ]).items.slice(),
  resultFilePath: string = '',
): RequestContext<ReviewAgentRequestContext> {
  return new RequestContext<ReviewAgentRequestContext>([
    ['userId', 'test-user'],
    ['aiApiKey', 'test-key'],
    ['aiApiEndpointUrl', 'http://localhost'],
    ['aiModelName', 'test-model'],
    ['projectDir', '/test/project'],
    ['checkItems', checkItems],
    [
      'ratings',
      [
        { label: 'A', definition: 'Fully satisfies requirements' },
        { label: 'B', definition: 'Partially satisfies requirements' },
        { label: 'C', definition: 'Does not satisfy requirements' },
      ],
    ],
    ['commentFormat', '## Review\n{comment}'],
    ['additionalInstructions', ''],
    ['resultFilePath', resultFilePath],
    ['commentLanguage', 'Japanese'],
    ['mrTitle', 'Test MR'],
    ['mrDescription', 'Test description'],
    ['mrSourceBranch', 'feature/test'],
    ['mrTargetBranch', 'main'],
    ['mrDiff', '+ added line'],
    ['priorReviewContext', null],
    ['skillsPaths', []],
    ['folderTree', 'src/\n  index.ts'],
  ]);
}

/**
 * テスト用のモックMemoryを作成するヘルパー
 */
function createMockMemory() {
  return {
    deleteThread: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue({ messages: [] }),
  };
}

/**
 * テスト用のモックAgentを作成するヘルパー
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
 * テスト用のモック要約Agentを作成するヘルパー
 */
function createMockSummarizationAgent(summaryText: string): Agent {
  return createMockAgent(vi.fn().mockResolvedValue({ text: summaryText }));
}

/**
 * テスト用のIndexedCheckItem配列を生成するヘルパー
 */
function makeItems(contents: string[]): IndexedCheckItem[] {
  return new IndexedChecklist(contents).items.slice();
}

/**
 * テスト用のコンテキスト長APICallErrorを生成するヘルパー
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

/**
 * テスト用の基本設定を生成するヘルパー
 */
function createBaseConfig(overrides: Partial<ReviewExecutionConfig> = {}): ReviewExecutionConfig {
  const checkItems = overrides.checkItems ?? makeItems(['security check', 'performance check']);
  const resultFilePath = overrides.resultFilePath ?? '';
  return {
    checkItems,
    agent: {} as Agent,
    summarizationAgent: createMockSummarizationAgent('Summary of work'),
    requestContext:
      overrides.requestContext ?? createTestRequestContext(checkItems, resultFilePath),
    resultFilePath,
    rateLimitRetryConfig: DEFAULT_RATE_LIMIT_RETRY_CONFIG,
    ...overrides,
  };
}

describe('executeReview', () => {
  let tmpDir: string;
  let resultFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-exec-test-'));
    resultFilePath = path.join(tmpDir, 'results.json');
    vi.clearAllMocks();
    initializeLogger({ userId: 'test-user', level: 'silent' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetLogger();
  });

  it('グループ内の全チェック項目のレビュー結果が返される', async () => {
    const checkItems = makeItems(['security check', 'performance check']);
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemId: 1,
            ratingLabel: 'A',
            ratingDefinition: 'Fully satisfies requirements',
            comment: 'Security is well implemented',
            isError: false,
          },
          {
            checkItemId: 2,
            ratingLabel: 'B',
            ratingDefinition: 'Partially satisfies requirements',
            comment: 'Performance could be improved',
            isError: false,
          },
        ]);
      }),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(2);

    expect(results[0].checkItem.content).toBe('security check');
    expect(results[0].rating.label).toBe('A');
    expect(results[0].comment).toBe('Security is well implemented');
    expect(results[0].isError).toBe(false);

    expect(results[1].checkItem.content).toBe('performance check');
    expect(results[1].rating.label).toBe('B');
    expect(results[1].comment).toBe('Performance could be improved');
    expect(results[1].isError).toBe(false);
  });

  it('agent.generate()にrequestContextが渡される', async () => {
    const checkItems = makeItems(['check1']);
    const generateFn = vi.fn().mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Good',
          isError: false,
        },
      ]);
    });
    const mockAgent = createMockAgent(generateFn);
    const requestContext = createTestRequestContext(checkItems);
    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      agent: mockAgent,
      requestContext,
    });

    await executeReview(config);

    expect(generateFn).toHaveBeenCalledTimes(1);
    const callOptions = generateFn.mock.calls[0][1];
    expect(callOptions.requestContext).toBe(requestContext);
  });

  it('初回のuserプロンプトにMR情報が含まれる', async () => {
    const checkItems = makeItems(['check1']);
    const generateFn = vi.fn().mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Good',
          isError: false,
        },
      ]);
    });
    const mockAgent = createMockAgent(generateFn);
    const requestContext = createTestRequestContext(checkItems, resultFilePath);
    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      agent: mockAgent,
      requestContext,
    });

    await executeReview(config);

    const prompt = generateFn.mock.calls[0][0] as string;
    expect(prompt).toContain('Test MR');
    expect(prompt).toContain('Test description');
    expect(prompt).toContain('feature/test');
  });

  it('Agent実行後に漏れがあった場合、再度Agentに指示される (max 2 retries)', async () => {
    const checkItems = makeItems(['item1', 'item2', 'item3']);

    let callCount = 0;
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Fully satisfies requirements',
              comment: 'Good',
              isError: false,
            },
          ]);
        } else if (callCount === 2) {
          const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
          existing.push({
            checkItemId: 2,
            ratingLabel: 'B',
            ratingDefinition: 'Partially satisfies requirements',
            comment: 'Needs improvement',
            isError: false,
          });
          writeResultsToFile(resultFilePath, existing);
        } else if (callCount === 3) {
          const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
          existing.push({
            checkItemId: 3,
            ratingLabel: 'A',
            ratingDefinition: 'Fully satisfies requirements',
            comment: 'Excellent',
            isError: false,
          });
          writeResultsToFile(resultFilePath, existing);
        }
      }),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);

    expect(results).toHaveLength(3);
    expect(results[0].checkItem.content).toBe('item1');
    expect(results[0].isError).toBe(false);
    expect(results[1].checkItem.content).toBe('item2');
    expect(results[1].isError).toBe(false);
    expect(results[2].checkItem.content).toBe('item3');
    expect(results[2].isError).toBe(false);
  });

  it('リトライ上限を超えても漏れがある場合、漏れた項目はエラー結果になる', async () => {
    const checkItems = makeItems(['item1', 'item2', 'item3']);

    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemId: 1,
            ratingLabel: 'A',
            ratingDefinition: 'Fully satisfies requirements',
            comment: 'Good',
            isError: false,
          },
        ]);
      }),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);

    expect(results).toHaveLength(3);
    expect(results[0].checkItem.content).toBe('item1');
    expect(results[0].isError).toBe(false);

    expect(results[1].checkItem.content).toBe('item2');
    expect(results[1].isError).toBe(true);
    expect(results[1].errorMessage).toContain('Review result not found after agent execution');

    expect(results[2].checkItem.content).toBe('item3');
    expect(results[2].isError).toBe(true);
  });

  it('Agentがエラーの場合、部分結果が保持され未完了項目のみエラーになる', async () => {
    const checkItems = makeItems(['security check', 'performance check']);

    const mockAgent = createMockAgent(
      vi.fn().mockRejectedValue(new Error('AI API connection failed')),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(2);
    // 部分結果がないので両方エラー
    expect(results[0].isError).toBe(true);
    expect(results[1].isError).toBe(true);
  });

  it('Agentがエラー（非Errorオブジェクト）の場合、定型エラーメッセージが返される', async () => {
    const checkItems = makeItems(['check1']);

    const mockAgent = createMockAgent(vi.fn().mockRejectedValue('string error'));
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe(UNEXPECTED_ERROR_MESSAGE);
  });

  it('リトライ中にAgentがエラーの場合でも処理が継続される', async () => {
    const checkItems = makeItems(['item1', 'item2']);

    let callCount = 0;
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Fully satisfies requirements',
              comment: 'Good',
              isError: false,
            },
          ]);
        } else {
          throw new Error('Retry failed');
        }
      }),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(2);
    expect(results[0].checkItem.content).toBe('item1');
    expect(results[0].isError).toBe(false);
    expect(results[1].checkItem.content).toBe('item2');
    expect(results[1].isError).toBe(true);
  });

  it('リトライ中にAgentが一部結果を格納した後エラーになっても、格納済み結果は保持される', async () => {
    const checkItems = makeItems(['item1', 'item2', 'item3', 'item4', 'item5']);

    let callCount = 0;
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // 初回: 3項目成功
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'OK',
              isError: false,
            },
            {
              checkItemId: 2,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'OK',
              isError: false,
            },
            {
              checkItemId: 3,
              ratingLabel: 'B',
              ratingDefinition: 'Partial',
              comment: 'Needs work',
              isError: false,
            },
          ]);
        } else if (callCount === 2) {
          // リトライ: 1項目追加格納後にエラー
          const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
          existing.push({
            checkItemId: 4,
            ratingLabel: 'A',
            ratingDefinition: 'Good',
            comment: 'Done',
            isError: false,
          });
          writeResultsToFile(resultFilePath, existing);
          throw new Error('Agent crashed after partial write');
        }
      }),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(5);
    // 初回で格納された3項目は保持
    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(false);
    expect(results[2].isError).toBe(false);
    // リトライ中に格納された1項目も保持
    expect(results[3].isError).toBe(false);
    expect(results[3].checkItem.content).toBe('item4');
    // 未格納の1項目のみエラー
    expect(results[4].isError).toBe(true);
    expect(results[4].checkItem.content).toBe('item5');
  });

  it('Agentが結果ファイルを作成しない場合、全項目がエラー結果になる', async () => {
    const checkItems = makeItems(['check1', 'check2']);

    const mockAgent = createMockAgent(vi.fn().mockResolvedValue(undefined));
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);

    expect(results).toHaveLength(2);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toContain('Review result not found after agent execution');
    expect(results[1].isError).toBe(true);
    expect(results[1].errorMessage).toContain('Review result not found after agent execution');
  });

  it('結果ファイルにisError=trueの結果がある場合、エラー結果として返される', async () => {
    const checkItems = makeItems(['check1']);

    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemId: 1,
            ratingLabel: 'エラー',
            ratingDefinition: 'エラーが発生しました',
            comment: 'Failed to review',
            isError: true,
            errorMessage: 'Tool execution failed',
          },
        ]);
      }),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe('Tool execution failed');
  });

  it('generate呼び出し時にmemoryオプション（thread, resource）が渡される', async () => {
    const checkItems = makeItems(['check1']);
    const generateFn = vi.fn().mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Good',
          isError: false,
        },
      ]);
    });
    const mockAgent = createMockAgent(generateFn);
    const requestContext = createTestRequestContext(checkItems);
    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      agent: mockAgent,
      requestContext,
    });

    await executeReview(config);

    expect(generateFn).toHaveBeenCalledTimes(1);
    const callOptions = generateFn.mock.calls[0][1];
    expect(callOptions.memory).toBeDefined();
    expect(callOptions.memory.thread).toEqual(expect.any(String));
    expect(callOptions.memory.thread).toHaveLength(36);
    expect(callOptions.memory.resource).toBe('test-user');
  });

  it('リトライ時も同じthreadIdが使用される', async () => {
    const checkItems = makeItems(['item1', 'item2']);

    let callCount = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        writeResultsToFile(resultFilePath, [
          {
            checkItemId: 1,
            ratingLabel: 'A',
            ratingDefinition: 'Fully satisfies requirements',
            comment: 'Good',
            isError: false,
          },
        ]);
      } else {
        const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
        existing.push({
          checkItemId: 2,
          ratingLabel: 'B',
          ratingDefinition: 'Partially satisfies requirements',
          comment: 'OK',
          isError: false,
        });
        writeResultsToFile(resultFilePath, existing);
      }
    });
    const mockAgent = createMockAgent(generateFn);
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    await executeReview(config);

    expect(generateFn).toHaveBeenCalledTimes(2);
    const firstCallMemory = generateFn.mock.calls[0][1].memory;
    const secondCallMemory = generateFn.mock.calls[1][1].memory;
    expect(firstCallMemory.thread).toBe(secondCallMemory.thread);
    expect(firstCallMemory.resource).toBe(secondCallMemory.resource);
  });

  it('実行完了後にスレッドが削除される', async () => {
    const checkItems = makeItems(['check1']);
    const mockMemory = createMockMemory();
    const generateFn = vi.fn().mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Good',
          isError: false,
        },
      ]);
    });
    const mockAgent = createMockAgent(generateFn, mockMemory);
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    await executeReview(config);

    expect(mockMemory.deleteThread).toHaveBeenCalledTimes(1);
    const usedThreadId = generateFn.mock.calls[0][1].memory.thread;
    expect(mockMemory.deleteThread).toHaveBeenCalledWith(usedThreadId);
  });

  it('エージェントエラー時でもスレッドが削除される', async () => {
    const checkItems = makeItems(['check1']);
    const mockMemory = createMockMemory();
    const mockAgent = createMockAgent(
      vi.fn().mockRejectedValue(new Error('AI API failed')),
      mockMemory,
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    await executeReview(config);

    expect(mockMemory.deleteThread).toHaveBeenCalledTimes(1);
  });

  it('スレッド削除が失敗しても結果は正常に返される', async () => {
    const checkItems = makeItems(['check1']);
    const mockMemory = {
      ...createMockMemory(),
      deleteThread: vi.fn().mockRejectedValue(new Error('DB locked')),
    };
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemId: 1,
            ratingLabel: 'A',
            ratingDefinition: 'Fully satisfies requirements',
            comment: 'Good',
            isError: false,
          },
        ]);
      }),
      mockMemory,
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(false);
    expect(results[0].rating.label).toBe('A');
    expect(mockMemory.deleteThread).toHaveBeenCalledTimes(1);
  });

  it('priorReviewContextがRequestContextに含まれる場合でも正しくレビュー結果が返される', async () => {
    const checkItems = makeItems(['check1']);

    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemId: 1,
            ratingLabel: 'A',
            ratingDefinition: 'Fully satisfies requirements',
            comment: 'Improved',
            isError: false,
          },
        ]);
      }),
    );

    const requestContext = new RequestContext<ReviewAgentRequestContext>([
      ['userId', 'test-user'],
      ['aiApiKey', 'test-key'],
      ['aiApiEndpointUrl', 'http://localhost'],
      ['aiModelName', 'test-model'],
      ['projectDir', '/test/project'],
      ['checkItems', checkItems],
      ['ratings', [{ label: 'A', definition: 'Fully satisfies requirements' }]],
      ['commentFormat', '## Review\n{comment}'],
      ['additionalInstructions', ''],
      ['resultFilePath', resultFilePath],
      ['commentLanguage', 'Japanese'],
      ['mrTitle', 'Test MR'],
      ['mrDescription', 'Test description'],
      ['mrSourceBranch', 'feature/test'],
      ['mrTargetBranch', 'main'],
      ['mrDiff', '+ added line'],
      [
        'priorReviewContext',
        {
          results: [{ checkItemContent: 'check1', ratingLabel: 'B', comment: 'Previous comment' }],
          commitMessages: ['fix: update security'],
          diffSincePrior: '+ new line',
        },
      ],
      ['skillsPaths', []],
      ['folderTree', 'src/\n  index.ts'],
    ]);

    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      agent: mockAgent,
      requestContext,
    });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(false);
  });

  it('初回のレート制限エラー→リトライ→成功の場合、継続プロンプトでレビュー結果が正常に返される', async () => {
    const checkItems = makeItems(['check1']);
    const rateLimitError = new APICallError({
      message: 'Rate limit exceeded',
      url: 'http://test-api/v1/chat',
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });

    let callCount = 0;
    const generateFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw rateLimitError;
      }
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Good',
          isError: false,
        },
      ]);
    });
    const mockAgent = createMockAgent(generateFn);
    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      agent: mockAgent,
      rateLimitRetryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
    });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(false);
    expect(results[0].rating.label).toBe('A');
    expect(callCount).toBe(2);
    // 2回目は継続プロンプトが送信される
    const secondPrompt = generateFn.mock.calls[1][0] as string;
    expect(secondPrompt).toContain('Rate Limit Recovery Notice');
  });

  it('レート制限以外のエラーはリトライされずエラー結果が返される', async () => {
    const checkItems = makeItems(['check1']);
    const genericError = new Error('Internal server error');
    const mockAgent = createMockAgent(vi.fn().mockRejectedValue(genericError));
    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      agent: mockAgent,
      rateLimitRetryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
    });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    // 通常ErrorはAPICallErrorではないのでunknownに分類される
    expect(results[0].errorMessage).toBe(UNEXPECTED_ERROR_MESSAGE);
    expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  // --- 新規テスト: エラーハンドリング見直し ---

  describe('API呼び出しエラーのハンドリング', () => {
    it('API呼び出しエラー時、部分結果が保持され未完了項目にエラーメッセージが表示される', async () => {
      const checkItems = makeItems(['check1', 'check2', 'check3']);

      let callCount = 0;
      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // 部分結果を書き込んでからAPIエラー
            writeResultsToFile(resultFilePath, [
              {
                checkItemId: 1,
                ratingLabel: 'A',
                ratingDefinition: 'Good',
                comment: 'OK',
                isError: false,
              },
            ]);
            throw new APICallError({
              message: 'Invalid API key',
              url: 'http://test-api/v1/chat',
              requestBodyValues: {},
              statusCode: 401,
              isRetryable: false,
            });
          }
        }),
      );

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      expect(results).toHaveLength(3);
      // 成功した結果は保持される
      expect(results[0].isError).toBe(false);
      expect(results[0].rating.label).toBe('A');
      // 未完了項目はAPIエラーメッセージが表示される
      expect(results[1].isError).toBe(true);
      expect(results[1].errorMessage).toContain('Invalid API key');
      expect(results[2].isError).toBe(true);
      expect(results[2].errorMessage).toContain('Invalid API key');
    });
  });

  describe('その他のエラーのハンドリング', () => {
    it('その他のエラー時、部分結果が保持され未完了項目に定型メッセージが表示される', async () => {
      const checkItems = makeItems(['check1', 'check2']);

      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          // 部分結果を書き込んでから通常エラー
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'OK',
              isError: false,
            },
          ]);
          throw new Error('Something unexpected happened');
        }),
      );

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      expect(results).toHaveLength(2);
      expect(results[0].isError).toBe(false);
      expect(results[1].isError).toBe(true);
      expect(results[1].errorMessage).toBe(UNEXPECTED_ERROR_MESSAGE);
    });
  });

  describe('レート制限リカバリーのハンドリング', () => {
    it('レート制限エラー → バックオフ → 継続プロンプトで再開 → 成功', async () => {
      const checkItems = makeItems(['check1', 'check2']);
      const rateLimitError = new APICallError({
        message: 'Rate limit exceeded',
        url: 'http://test-api/v1/chat',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });

      let callCount = 0;
      const generateFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // 初回: 部分結果を書いてからレート制限エラー
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'OK',
              isError: false,
            },
          ]);
          throw rateLimitError;
        }
        // 継続: 残りの結果を書く
        const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
        existing.push({
          checkItemId: 2,
          ratingLabel: 'B',
          ratingDefinition: 'Partial',
          comment: 'Needs work',
          isError: false,
        });
        writeResultsToFile(resultFilePath, existing);
      });
      const mockAgent = createMockAgent(generateFn);
      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      expect(results).toHaveLength(2);
      expect(results[0].isError).toBe(false);
      expect(results[1].isError).toBe(false);
      // 2回目の呼び出しでは継続プロンプトが送信される
      const secondPrompt = generateFn.mock.calls[1][0] as string;
      expect(secondPrompt).toContain('Rate Limit Recovery Notice');
      expect(secondPrompt).toContain('Already Reviewed Items');
      expect(secondPrompt).toContain('[ID: 1]');
    });

    it('レート制限リカバリー時、同じスレッドIDが使用される', async () => {
      const checkItems = makeItems(['check1']);
      const rateLimitError = new APICallError({
        message: 'Rate limit exceeded',
        url: 'http://test-api/v1/chat',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });

      let callCount = 0;
      const generateFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw rateLimitError;
        writeResultsToFile(resultFilePath, [
          {
            checkItemId: 1,
            ratingLabel: 'A',
            ratingDefinition: 'Good',
            comment: 'OK',
            isError: false,
          },
        ]);
      });
      const mockAgent = createMockAgent(generateFn);
      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 },
      });

      await executeReview(config);

      const firstMemory = generateFn.mock.calls[0][1].memory;
      const secondMemory = generateFn.mock.calls[1][1].memory;
      expect(firstMemory.thread).toBe(secondMemory.thread);
    });

    it('レート制限リトライ上限到達時、部分結果が保持されエラー結果が返される', async () => {
      const checkItems = makeItems(['check1', 'check2']);
      const rateLimitError = new APICallError({
        message: 'Rate limit exceeded',
        url: 'http://test-api/v1/chat',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });

      let callCount = 0;
      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // 初回: 部分結果を書いてからレート制限
            writeResultsToFile(resultFilePath, [
              {
                checkItemId: 1,
                ratingLabel: 'A',
                ratingDefinition: 'Good',
                comment: 'OK',
                isError: false,
              },
            ]);
          }
          throw rateLimitError;
        }),
      );
      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      expect(results).toHaveLength(2);
      // 部分結果は保持
      expect(results[0].isError).toBe(false);
      expect(results[0].rating.label).toBe('A');
      // 未完了項目はエラー
      expect(results[1].isError).toBe(true);
      // maxRetries=2 → 初回 + 2回リトライ = 3回呼び出し
      expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);
    });

    it('コンテキスト長リカバリー後にレート制限カウンタがリセットされる', async () => {
      const checkItems = makeItems(['check1']);
      const mockMemory = createMockMemory();
      const rateLimitError = new APICallError({
        message: 'Rate limit exceeded',
        url: 'http://test-api/v1/chat',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });

      let callCount = 0;
      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) throw rateLimitError; // rate limit
          if (callCount === 2) throw createContextLengthError(); // context length
          if (callCount === 3) throw rateLimitError; // rate limit again (counter should be reset)
          // 4th call: success
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'OK',
              isError: false,
            },
          ]);
        }),
        mockMemory,
      );
      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(false);
      expect(callCount).toBe(4);
    });
  });

  describe('buildRateLimitContinuationPrompt', () => {
    it('レート制限リカバリー通知とレビュー済み項目が含まれる', () => {
      const checkItems = makeItems(['check1', 'check2', 'check3']);
      const prompt = buildRateLimitContinuationPrompt([1, 2], checkItems);

      expect(prompt).toContain('Rate Limit Recovery Notice');
      expect(prompt).toContain('Already Reviewed Items');
      expect(prompt).toContain('[ID: 1] check1');
      expect(prompt).toContain('[ID: 2] check2');
      expect(prompt).not.toContain('[ID: 3]');
      expect(prompt).toContain('resume reviewing');
    });

    it('レビュー済み項目がない場合、"None"が表示される', () => {
      const checkItems = makeItems(['check1']);
      const prompt = buildRateLimitContinuationPrompt([], checkItems);

      expect(prompt).toContain('None');
    });
  });

  describe('コンテキスト長エラーのハンドリング', () => {
    it('コンテキスト長エラー → リカバリー → 継続 → 成功', async () => {
      const checkItems = makeItems(['check1', 'check2']);
      const mockMemory = createMockMemory();

      let agentCallCount = 0;
      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          agentCallCount++;
          if (agentCallCount === 1) {
            // 初回: 部分結果を書いてからコンテキスト長エラー
            writeResultsToFile(resultFilePath, [
              {
                checkItemId: 1,
                ratingLabel: 'A',
                ratingDefinition: 'Good',
                comment: 'OK',
                isError: false,
              },
            ]);
            throw createContextLengthError();
          }
          // 継続: 残りの結果を書く
          const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
          existing.push({
            checkItemId: 2,
            ratingLabel: 'B',
            ratingDefinition: 'Partial',
            comment: 'Needs work',
            isError: false,
          });
          writeResultsToFile(resultFilePath, existing);
        }),
        mockMemory,
      );

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      expect(results).toHaveLength(2);
      expect(results[0].isError).toBe(false);
      expect(results[0].rating.label).toBe('A');
      expect(results[1].isError).toBe(false);
      expect(results[1].rating.label).toBe('B');
    });

    it('コンテキスト長エラー → リカバリー → 再度コンテキスト長 → 再リカバリー → 成功', async () => {
      const checkItems = makeItems(['check1']);
      const mockMemory = createMockMemory();

      let agentCallCount = 0;
      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          agentCallCount++;
          if (agentCallCount <= 2) {
            throw createContextLengthError();
          }
          // 3回目で成功
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'Finally done',
              isError: false,
            },
          ]);
        }),
        mockMemory,
      );

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      expect(results).toHaveLength(1);
      expect(results[0].isError).toBe(false);
      expect(results[0].comment).toBe('Finally done');
      // 3回呼び出されるはず（初回 + 2回リカバリー後の継続）
      expect(agentCallCount).toBe(3);
    });

    it('継続プロンプトがPBI指定の構成に従っている', async () => {
      const checkItems = makeItems(['check1', 'check2']);
      const mockMemory = createMockMemory();

      let agentCallCount = 0;
      const agentGenerateFn = vi.fn().mockImplementation(async () => {
        agentCallCount++;
        if (agentCallCount === 1) {
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'OK',
              isError: false,
            },
          ]);
          throw createContextLengthError();
        }
        // 継続成功
        const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
        existing.push({
          checkItemId: 2,
          ratingLabel: 'B',
          ratingDefinition: 'Partial',
          comment: 'Done',
          isError: false,
        });
        writeResultsToFile(resultFilePath, existing);
      });
      const mockAgent = createMockAgent(agentGenerateFn, mockMemory);

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      await executeReview(config);

      // 2回目の呼び出し（継続プロンプト）を検証
      const continuationPrompt = agentGenerateFn.mock.calls[1][0] as string;
      // 1. 通常のuserプロンプト内容（MR情報）
      expect(continuationPrompt).toContain('Test MR');
      // 2. レビュー済みチェック項目
      expect(continuationPrompt).toContain('Already Reviewed Items');
      expect(continuationPrompt).toContain('[ID: 1]');
      // 3. コンテキスト逼迫の旨
      expect(continuationPrompt).toContain('Context Length Recovery Notice');
      // 4. 要約内容
      expect(continuationPrompt).toContain('Summary of Previous Work');
    });

    it('コンテキスト長リカバリー失敗時、部分結果が保持される', async () => {
      const checkItems = makeItems(['check1', 'check2']);
      const mockMemory = createMockMemory();

      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'OK',
              isError: false,
            },
          ]);
          throw createContextLengthError();
        }),
        mockMemory,
      );

      // 要約Agent失敗
      const failingSummarizationAgent = createMockAgent(
        vi.fn().mockRejectedValue(new Error('Summarization failed')),
      );

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        summarizationAgent: failingSummarizationAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      // 要約失敗はcatchされてclassifyErrorで分類される（context_length以外）
      expect(results).toHaveLength(2);
      expect(results[0].isError).toBe(false); // 部分結果は保持
      expect(results[1].isError).toBe(true);
    });

    it('全スレッドがクリーンアップされる', async () => {
      const checkItems = makeItems(['check1']);
      const mockMemory = createMockMemory();

      let agentCallCount = 0;
      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          agentCallCount++;
          if (agentCallCount === 1) {
            throw createContextLengthError();
          }
          writeResultsToFile(resultFilePath, [
            {
              checkItemId: 1,
              ratingLabel: 'A',
              ratingDefinition: 'Good',
              comment: 'Done',
              isError: false,
            },
          ]);
        }),
        mockMemory,
      );

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      await executeReview(config);

      // 旧スレッド + リカバリーで作成された新スレッド = 2回削除
      // ただしrecoverFromContextLengthが旧スレッドを削除し、
      // finallyで全スレッドを削除するので、deleteThreadの呼び出し回数は3回（recovery内1回 + finally2回）
      expect(mockMemory.deleteThread.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('コンテキスト長リカバリー上限（3回）到達時、部分結果で終了する', async () => {
      const checkItems = makeItems(['check1', 'check2']);
      const mockMemory = createMockMemory();

      // 全てのgenerate呼び出しでコンテキスト長エラーを投げる（4回: 初回 + 3回リカバリー後の継続）
      let agentCallCount = 0;
      const mockAgent = createMockAgent(
        vi.fn().mockImplementation(async () => {
          agentCallCount++;
          if (agentCallCount === 1) {
            // 初回: 部分結果を書いてからエラー
            writeResultsToFile(resultFilePath, [
              {
                checkItemId: 1,
                ratingLabel: 'A',
                ratingDefinition: 'Good',
                comment: 'OK',
                isError: false,
              },
            ]);
          }
          throw createContextLengthError();
        }),
        mockMemory,
      );

      const config = createBaseConfig({
        checkItems,
        resultFilePath,
        agent: mockAgent,
        rateLimitRetryConfig: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      });

      const results = await executeReview(config);

      // 無限ループせずに終了し、部分結果が保持される
      // 初回executeWithContextLengthRecovery(4回) + リトライループ(2回 × 4回) = 12回
      expect(agentCallCount).toBe(12);
      expect(results).toHaveLength(2);
      expect(results[0].isError).toBe(false);
      expect(results[0].rating.label).toBe('A');
      // 未完了項目はエラー
      expect(results[1].isError).toBe(true);
    });
  });
});
