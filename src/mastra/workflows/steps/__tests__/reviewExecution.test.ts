import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { IndexedChecklist } from '../../../indexedCheckItem.js';
import type { IndexedCheckItem } from '../../../indexedCheckItem.js';
import { executeReview, type ReviewExecutionConfig } from '../reviewExecution.js';
import type { Agent } from '@mastra/core/agent';
import type { ReviewAgentRequestContext } from '../../../requestContext.js';

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
    ['mrTitle', 'Test MR'],
    ['mrDescription', 'Test description'],
    ['mrSourceBranch', 'feature/test'],
    ['mrTargetBranch', 'main'],
    ['mrDiff', '+ added line'],
    ['priorReviewContext', null],
    ['skillsPaths', []],
  ]);
}

/**
 * テスト用のモックMemoryを作成するヘルパー
 */
function createMockMemory() {
  return {
    deleteThread: vi.fn().mockResolvedValue(undefined),
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
 * テスト用のIndexedCheckItem配列を生成するヘルパー
 */
function makeItems(contents: string[]): IndexedCheckItem[] {
  return new IndexedChecklist(contents).items.slice();
}

/**
 * テスト用の基本設定を生成するヘルパー
 */
function createBaseConfig(overrides: Partial<ReviewExecutionConfig> = {}): ReviewExecutionConfig {
  const checkItems = overrides.checkItems ?? makeItems(['security check', 'performance check']);
  return {
    checkItems,
    agent: {} as Agent,
    requestContext: createTestRequestContext(checkItems),
    resultFilePath: '',
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
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('Agent実行後に漏れがあった場合、再度Agentに指示される (max 2 retries)', async () => {
    const checkItems = makeItems(['item1', 'item2', 'item3']);

    let callCount = 0;
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // 初回: ID:1のみ返す（ID:2, ID:3が漏れ）
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
          // リトライ1回目: ID:2を追加
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
          // リトライ2回目: ID:3を追加
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
        // 常にID:1のみ返す（ID:2, ID:3は永遠に漏れ）
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

  it('Agentがエラーの場合、エラー結果が返される', async () => {
    const checkItems = makeItems(['security check', 'performance check']);

    const mockAgent = createMockAgent(
      vi.fn().mockRejectedValue(new Error('AI API connection failed')),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(2);

    expect(results[0].checkItem.content).toBe('security check');
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe('AI API connection failed');

    expect(results[1].checkItem.content).toBe('performance check');
    expect(results[1].isError).toBe(true);
    expect(results[1].errorMessage).toBe('AI API connection failed');
  });

  it('Agentがエラー（非Errorオブジェクト）の場合、デフォルトエラーメッセージが返される', async () => {
    const checkItems = makeItems(['check1']);

    const mockAgent = createMockAgent(vi.fn().mockRejectedValue('string error'));
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe('Agent execution failed');
  });

  it('リトライ中にAgentがエラーの場合でも処理が継続される', async () => {
    const checkItems = makeItems(['item1', 'item2']);

    let callCount = 0;
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // 初回: ID:1のみ返す
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
    expect(callOptions.memory.thread).toHaveLength(36); // UUID形式
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
    // deleteThreadに渡されたthreadIdがgenerate時のthreadIdと一致する
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

    // エラーでもfinallyでクリーンアップが実行される
    expect(mockMemory.deleteThread).toHaveBeenCalledTimes(1);
  });

  it('スレッド削除が失敗しても結果は正常に返される', async () => {
    const checkItems = makeItems(['check1']);
    const mockMemory = {
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

    // クリーンアップ失敗してもレビュー結果は正常に返される
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

    // priorReviewContextを含むRequestContext
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
});
