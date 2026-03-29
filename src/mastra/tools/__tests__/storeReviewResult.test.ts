import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { storeReviewResultTool } from '../storeReviewResult.js';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';

/**
 * テスト用のデフォルト評定基準
 */
const defaultRatings = [
  { label: 'A', definition: '完全に満たしている' },
  { label: 'B', definition: '概ね満たしている' },
  { label: 'C', definition: '改善が必要' },
];

/**
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 * RequestContextにresultFilePath, ratingsを設定
 */
const executeStore = (
  input: {
    checkItemId: number;
    ratingLabel: string;
    comment: string;
  },
  resultFilePath: string,
  ratings: Array<{ label: string; definition: string }> = defaultRatings,
): Promise<{ success: boolean; message?: string }> => {
  const executeFn = storeReviewResultTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([
    ['resultFilePath', resultFilePath],
    ['ratings', ratings],
  ]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof storeReviewResultTool.execute>>[1];
  return executeFn(input, context) as Promise<{ success: boolean; message?: string }>;
};

describe('storeReviewResult', () => {
  let tmpDir: string;
  let filePath: string;

  // テストごとに一時ディレクトリを作成
  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-review-result-'));
    filePath = path.join(tmpDir, 'results.json');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('レビュー結果をjsonファイルに書き込める', async () => {
    createTmpDir();
    const result = await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'A',
        comment: '可読性は十分です',
      },
      filePath,
    );

    expect(result.success).toBe(true);

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      checkItemId: 1,
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '可読性は十分です',
      isError: false,
    });
  });

  it('既存の結果に追記できる', async () => {
    createTmpDir();
    // 1件目を書き込み
    await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'A',
        comment: '可読性は十分です',
      },
      filePath,
    );

    // 2件目を書き込み
    await executeStore(
      {
        checkItemId: 2,
        ratingLabel: 'B',
        comment: 'カバレッジは75%です',
      },
      filePath,
    );

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(2);
    expect(stored[0].checkItemId).toBe(1);
    expect(stored[1].checkItemId).toBe(2);
  });

  it('同じチェック項目IDの結果は上書きされる', async () => {
    createTmpDir();
    // 1回目の書き込み
    await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'C',
        comment: '可読性が低いです',
      },
      filePath,
    );

    // 同じIDで2回目の書き込み（上書き）
    await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'A',
        comment: '修正後、可読性は十分です',
      },
      filePath,
    );

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0].ratingLabel).toBe('A');
    expect(stored[0].comment).toBe('修正後、可読性は十分です');
  });

  it('ratingLabelに対応するdefinitionがratingsから正しく解決される', async () => {
    createTmpDir();
    await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'B',
        comment: '概ね問題ありません',
      },
      filePath,
    );

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored[0].ratingLabel).toBe('B');
    expect(stored[0].ratingDefinition).toBe('概ね満たしている');
  });

  it('存在しないratingLabelを指定した場合エラーが返される', async () => {
    createTmpDir();
    const result = await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'X',
        comment: '問題ありません',
      },
      filePath,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('X');
    // ファイルが作成されていないことを確認
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('isErrorは常にfalseで保存される', async () => {
    createTmpDir();
    await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'A',
        comment: '問題ありません',
      },
      filePath,
    );

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored[0].isError).toBe(false);
    expect(stored[0].errorMessage).toBeUndefined();
  });
});

/**
 * checkItems付きコンテキストでexecuteを呼び出すヘルパー
 */
const executeStoreWithContext = (
  input: {
    checkItemId: number;
    ratingLabel: string;
    comment: string;
  },
  resultFilePath: string,
  checkItems: IndexedCheckItem[],
  ratings: Array<{ label: string; definition: string }> = defaultRatings,
): Promise<{ success: boolean; message?: string }> => {
  const executeFn = storeReviewResultTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([
    ['resultFilePath', resultFilePath],
    ['ratings', ratings],
    ['checkItems', checkItems],
  ]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof storeReviewResultTool.execute>>[1];
  return executeFn(input, context) as Promise<{ success: boolean; message?: string }>;
};

describe('storeReviewResult - チェック項目IDバリデーション', () => {
  let tmpDir: string;
  let filePath: string;

  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-review-result-'));
    filePath = path.join(tmpDir, 'results.json');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('担当チェック項目のIDで呼び出した場合、結果が保存される', async () => {
    createTmpDir();
    const checkItems: IndexedCheckItem[] = [
      { id: 1, content: 'セキュリティチェック' },
      { id: 2, content: 'パフォーマンスチェック' },
    ];

    const result = await executeStoreWithContext(
      {
        checkItemId: 1,
        ratingLabel: 'A',
        comment: 'セキュリティは問題ありません',
      },
      filePath,
      checkItems,
    );

    expect(result.success).toBe(true);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0].checkItemId).toBe(1);
  });

  it('担当外のチェック項目IDで呼び出した場合、結果が保存されずエラーメッセージが返される', async () => {
    createTmpDir();
    const checkItems: IndexedCheckItem[] = [
      { id: 1, content: 'セキュリティチェック' },
      { id: 2, content: 'パフォーマンスチェック' },
    ];

    const result = await executeStoreWithContext(
      {
        checkItemId: 99,
        ratingLabel: 'A',
        comment: '問題ありません',
      },
      filePath,
      checkItems,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('99');
    expect(result.message).toContain('[ID: 1]');
    expect(result.message).toContain('[ID: 2]');
    // ファイルが作成されていないことを確認
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('RequestContextにcheckItemsがない場合、バリデーションをスキップして保存される', async () => {
    createTmpDir();

    // checkItemsなし
    const result = await executeStore(
      {
        checkItemId: 1,
        ratingLabel: 'A',
        comment: '問題ありません',
      },
      filePath,
    );

    expect(result.success).toBe(true);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
  });
});
