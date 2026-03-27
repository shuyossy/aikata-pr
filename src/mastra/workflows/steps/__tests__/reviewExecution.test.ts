import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { CheckItem } from '../../../../domain/checkItem/index.js';
import { executeReview, type ReviewExecutionConfig } from '../reviewExecution.js';
import type { Agent } from '@mastra/core/agent';
import type { ReviewAgentRequestContext } from '../../../requestContext.js';

/**
 * 結果ファイルにレビュー結果を書き込むヘルパー
 * Agent の storeReviewResult ツール呼び出しをシミュレートする
 */
function writeResultsToFile(
  filePath: string,
  results: Array<{
    checkItemContent: string;
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
  checkItems: string[] = ['security check', 'performance check'],
): RequestContext<ReviewAgentRequestContext> {
  return new RequestContext<ReviewAgentRequestContext>([
    ['userId', 'test-user'],
    ['aiApiKey', 'test-key'],
    ['aiApiEndpointUrl', 'http://localhost'],
    ['aiModelName', 'test-model'],
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
  ]);
}

/**
 * テスト用のモックAgentを作成するヘルパー
 */
function createMockAgent(generateFn: (...args: unknown[]) => Promise<unknown>): Agent {
  return { generate: generateFn } as unknown as Agent;
}

/**
 * テスト用の基本設定を生成するヘルパー
 */
function createBaseConfig(overrides: Partial<ReviewExecutionConfig> = {}): ReviewExecutionConfig {
  const checkItems = overrides.checkItems ?? [
    new CheckItem('security check'),
    new CheckItem('performance check'),
  ];
  return {
    checkItems,
    agent: {} as Agent,
    requestContext: createTestRequestContext(checkItems.map((i) => i.content)),
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
    // テンポラリディレクトリのクリーンアップ
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('グループ内の全チェック項目のレビュー結果が返される', async () => {
    const checkItems = [new CheckItem('security check'), new CheckItem('performance check')];
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemContent: 'security check',
            ratingLabel: 'A',
            ratingDefinition: 'Fully satisfies requirements',
            comment: 'Security is well implemented',
            isError: false,
          },
          {
            checkItemContent: 'performance check',
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

    // 全チェック項目に対するレビュー結果が返される
    expect(results).toHaveLength(2);

    // 1つ目の結果を検証
    expect(results[0].checkItem.content).toBe('security check');
    expect(results[0].rating.label).toBe('A');
    expect(results[0].comment).toBe('Security is well implemented');
    expect(results[0].isError).toBe(false);

    // 2つ目の結果を検証
    expect(results[1].checkItem.content).toBe('performance check');
    expect(results[1].rating.label).toBe('B');
    expect(results[1].comment).toBe('Performance could be improved');
    expect(results[1].isError).toBe(false);
  });

  it('agent.generate()にrequestContextが渡される', async () => {
    const checkItems = [new CheckItem('check1')];
    const generateFn = vi.fn().mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemContent: 'check1',
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Good',
          isError: false,
        },
      ]);
    });
    const mockAgent = createMockAgent(generateFn);
    const requestContext = createTestRequestContext(['check1']);
    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      agent: mockAgent,
      requestContext,
    });

    await executeReview(config);

    // generate()にrequestContextが渡されていること
    expect(generateFn).toHaveBeenCalledTimes(1);
    const callOptions = generateFn.mock.calls[0][1];
    expect(callOptions.requestContext).toBe(requestContext);
  });

  it('Agent実行後に漏れがあった場合、再度Agentに指示される (max 2 retries)', async () => {
    const checkItems = [new CheckItem('item1'), new CheckItem('item2'), new CheckItem('item3')];

    let callCount = 0;
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // 初回: item1のみ返す（item2, item3が漏れ）
          writeResultsToFile(resultFilePath, [
            {
              checkItemContent: 'item1',
              ratingLabel: 'A',
              ratingDefinition: 'Fully satisfies requirements',
              comment: 'Good',
              isError: false,
            },
          ]);
        } else if (callCount === 2) {
          // リトライ1回目: item2を追加（item3がまだ漏れ）
          const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
          existing.push({
            checkItemContent: 'item2',
            ratingLabel: 'B',
            ratingDefinition: 'Partially satisfies requirements',
            comment: 'Needs improvement',
            isError: false,
          });
          writeResultsToFile(resultFilePath, existing);
        } else if (callCount === 3) {
          // リトライ2回目: item3を追加
          const existing = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'));
          existing.push({
            checkItemContent: 'item3',
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

    // generate()が3回呼ばれる（初回 + リトライ2回）
    expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);

    // 全項目の結果が返される
    expect(results).toHaveLength(3);
    expect(results[0].checkItem.content).toBe('item1');
    expect(results[0].isError).toBe(false);
    expect(results[1].checkItem.content).toBe('item2');
    expect(results[1].isError).toBe(false);
    expect(results[2].checkItem.content).toBe('item3');
    expect(results[2].isError).toBe(false);
  });

  it('リトライ上限を超えても漏れがある場合、漏れた項目はエラー結果になる', async () => {
    const checkItems = [new CheckItem('item1'), new CheckItem('item2'), new CheckItem('item3')];

    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        // 常にitem1のみ返す（item2, item3は永遠に漏れ）
        writeResultsToFile(resultFilePath, [
          {
            checkItemContent: 'item1',
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

    // 初回 + 最大2回リトライ = 3回呼ばれる
    expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);

    // 全項目の結果が返される
    expect(results).toHaveLength(3);
    expect(results[0].checkItem.content).toBe('item1');
    expect(results[0].isError).toBe(false);

    // 漏れた項目はエラー結果
    expect(results[1].checkItem.content).toBe('item2');
    expect(results[1].isError).toBe(true);
    expect(results[1].errorMessage).toContain('Review result not found after agent execution');

    expect(results[2].checkItem.content).toBe('item3');
    expect(results[2].isError).toBe(true);
  });

  it('Agentがエラーの場合、エラー結果が返される', async () => {
    const checkItems = [new CheckItem('security check'), new CheckItem('performance check')];

    const mockAgent = createMockAgent(
      vi.fn().mockRejectedValue(new Error('AI API connection failed')),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    // 全項目がエラー結果になる
    expect(results).toHaveLength(2);

    expect(results[0].checkItem.content).toBe('security check');
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe('AI API connection failed');

    expect(results[1].checkItem.content).toBe('performance check');
    expect(results[1].isError).toBe(true);
    expect(results[1].errorMessage).toBe('AI API connection failed');
  });

  it('Agentがエラー（非Errorオブジェクト）の場合、デフォルトエラーメッセージが返される', async () => {
    const checkItems = [new CheckItem('check1')];

    const mockAgent = createMockAgent(vi.fn().mockRejectedValue('string error'));
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe('Agent execution failed');
  });

  it('リトライ中にAgentがエラーの場合でも処理が継続される', async () => {
    const checkItems = [new CheckItem('item1'), new CheckItem('item2')];

    let callCount = 0;
    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // 初回: item1のみ返す
          writeResultsToFile(resultFilePath, [
            {
              checkItemContent: 'item1',
              ratingLabel: 'A',
              ratingDefinition: 'Fully satisfies requirements',
              comment: 'Good',
              isError: false,
            },
          ]);
        } else {
          // リトライ時にエラー
          throw new Error('Retry failed');
        }
      }),
    );
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    // item1は成功、item2はエラー
    expect(results).toHaveLength(2);
    expect(results[0].checkItem.content).toBe('item1');
    expect(results[0].isError).toBe(false);
    expect(results[1].checkItem.content).toBe('item2');
    expect(results[1].isError).toBe(true);
  });

  it('Agentが結果ファイルを作成しない場合、全項目がエラー結果になる', async () => {
    const checkItems = [new CheckItem('check1'), new CheckItem('check2')];

    // Agentは成功するがファイルを作成しない
    const mockAgent = createMockAgent(vi.fn().mockResolvedValue(undefined));
    const config = createBaseConfig({ checkItems, resultFilePath, agent: mockAgent });

    const results = await executeReview(config);

    // 初回 + リトライ2回 = 3回呼ばれる（毎回ファイルが存在しないので漏れとみなされる）
    expect(mockAgent.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);

    // 全項目がエラー結果になる
    expect(results).toHaveLength(2);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toContain('Review result not found after agent execution');
    expect(results[1].isError).toBe(true);
    expect(results[1].errorMessage).toContain('Review result not found after agent execution');
  });

  it('結果ファイルにisError=trueの結果がある場合、エラー結果として返される', async () => {
    const checkItems = [new CheckItem('check1')];

    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemContent: 'check1',
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

  it('priorReviewContextがRequestContextに含まれる場合でも正しくレビュー結果が返される', async () => {
    const checkItems = [new CheckItem('check1')];

    const mockAgent = createMockAgent(
      vi.fn().mockImplementation(async () => {
        writeResultsToFile(resultFilePath, [
          {
            checkItemContent: 'check1',
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
      ['checkItems', ['check1']],
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
