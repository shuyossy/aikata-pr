import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CheckItem } from '../../../../domain/checkItem/index.js';
import { Rating } from '../../../../domain/rating/index.js';
import { MrContext } from '../../../../domain/mrContext/index.js';

// createReviewAgent をモック化
vi.mock('../../../agents/reviewAgent.js', () => ({
  createReviewAgent: vi.fn(),
}));

import { createReviewAgent } from '../../../agents/reviewAgent.js';
import { executeReview, type ReviewExecutionConfig } from '../reviewExecutionStep.js';

const mockedCreateReviewAgent = vi.mocked(createReviewAgent);

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
 * テスト用の基本設定を生成するヘルパー
 */
function createBaseConfig(overrides: Partial<ReviewExecutionConfig> = {}): ReviewExecutionConfig {
  return {
    checkItems: [new CheckItem('security check'), new CheckItem('performance check')],
    model: {} as ReviewExecutionConfig['model'],
    ratings: [
      new Rating('A', 'Fully satisfies requirements'),
      new Rating('B', 'Partially satisfies requirements'),
      new Rating('C', 'Does not satisfy requirements'),
    ],
    commentFormat: '## Review\n{comment}',
    additionalInstructions: '',
    mrContext: new MrContext({
      title: 'Test MR',
      description: 'Test description',
      sourceBranch: 'feature/test',
      targetBranch: 'main',
      diff: '+ added line',
      commitHash: 'abc123',
    }),
    priorReviewContext: null,
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
    const config = createBaseConfig({ checkItems, resultFilePath });

    // モックエージェントのgenerate()が呼ばれたら結果ファイルに全項目の結果を書き込む
    const mockAgent = {
      generate: vi.fn().mockImplementation(async () => {
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
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

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

    // createReviewAgentが正しい引数で呼ばれたか検証
    expect(mockedCreateReviewAgent).toHaveBeenCalledTimes(1);
  });

  it('Agent実行後に漏れがあった場合、再度Agentに指示される (max 2 retries)', async () => {
    const checkItems = [new CheckItem('item1'), new CheckItem('item2'), new CheckItem('item3')];
    const config = createBaseConfig({ checkItems, resultFilePath });

    let callCount = 0;
    const mockAgent = {
      generate: vi.fn().mockImplementation(async () => {
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
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

    const results = await executeReview(config);

    // generate()が3回呼ばれる（初回 + リトライ2回）
    expect(mockAgent.generate).toHaveBeenCalledTimes(3);

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
    const config = createBaseConfig({ checkItems, resultFilePath });

    const mockAgent = {
      generate: vi.fn().mockImplementation(async () => {
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
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

    const results = await executeReview(config);

    // 初回 + 最大2回リトライ = 3回呼ばれる
    expect(mockAgent.generate).toHaveBeenCalledTimes(3);

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
    const config = createBaseConfig({ checkItems, resultFilePath });

    const mockAgent = {
      generate: vi.fn().mockRejectedValue(new Error('AI API connection failed')),
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

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
    const config = createBaseConfig({ checkItems, resultFilePath });

    const mockAgent = {
      generate: vi.fn().mockRejectedValue('string error'),
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe('Agent execution failed');
  });

  it('リトライ中にAgentがエラーの場合でも処理が継続される', async () => {
    const checkItems = [new CheckItem('item1'), new CheckItem('item2')];
    const config = createBaseConfig({ checkItems, resultFilePath });

    let callCount = 0;
    const mockAgent = {
      generate: vi.fn().mockImplementation(async () => {
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
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

    const results = await executeReview(config);

    // item1は成功、item2はエラー
    expect(results).toHaveLength(2);
    expect(results[0].checkItem.content).toBe('item1');
    expect(results[0].isError).toBe(false);
    expect(results[1].checkItem.content).toBe('item2');
    expect(results[1].isError).toBe(true);
  });

  it('結果ファイルにisError=trueの結果がある場合、エラー結果として返される', async () => {
    const checkItems = [new CheckItem('check1')];
    const config = createBaseConfig({ checkItems, resultFilePath });

    const mockAgent = {
      generate: vi.fn().mockImplementation(async () => {
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
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

    const results = await executeReview(config);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].errorMessage).toBe('Tool execution failed');
  });

  it('priorReviewContextがある場合、createReviewAgentに渡される', async () => {
    const checkItems = [new CheckItem('check1')];
    // PriorReviewContextをインポートして直接オブジェクトを構築
    const { PriorReviewContext } = await import('../../../../domain/priorReviewContext/index.js');
    const { ReviewResult } = await import('../../../../domain/reviewResult/index.js');

    const priorReviewContext = new PriorReviewContext({
      results: [
        ReviewResult.success(
          new CheckItem('check1'),
          new Rating('B', 'Partial'),
          'Previous comment',
        ),
      ],
      commitMessages: ['fix: update security'],
      diffSincePrior: '+ new line',
    });

    const config = createBaseConfig({
      checkItems,
      resultFilePath,
      priorReviewContext,
    });

    const mockAgent = {
      generate: vi.fn().mockImplementation(async () => {
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
    };
    mockedCreateReviewAgent.mockReturnValue(mockAgent as never);

    const results = await executeReview(config);

    // createReviewAgentにpriorReviewContextが渡されていることを検証
    expect(mockedCreateReviewAgent).toHaveBeenCalledTimes(1);
    const callArgs = mockedCreateReviewAgent.mock.calls[0][0];
    expect(callArgs.priorReviewContext).not.toBeNull();
    expect(callArgs.priorReviewContext!.results).toHaveLength(1);
    expect(callArgs.priorReviewContext!.results[0].checkItemContent).toBe('check1');
    expect(callArgs.priorReviewContext!.commitMessages).toEqual(['fix: update security']);

    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(false);
  });
});
