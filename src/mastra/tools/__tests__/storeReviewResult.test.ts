import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { storeReviewResultTool } from '../storeReviewResult.js';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';

/**
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 * execute は Mastra の型定義上 undefined の可能性があるため非null断定で呼び出す
 */
const executeStore = (input: {
  filePath: string;
  checkItemId: number;
  ratingLabel: string;
  ratingDefinition: string;
  comment: string;
  isError: boolean;
  errorMessage?: string;
}): Promise<{ success: boolean }> => {
  // Mastra の型定義上 execute が undefined の可能性があるが、実装では常に定義されている
  const executeFn = storeReviewResultTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  return executeFn(
    input,
    {} as Parameters<NonNullable<typeof storeReviewResultTool.execute>>[1],
  ) as Promise<{ success: boolean }>;
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
    const result = await executeStore({
      filePath,
      checkItemId: 1,
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '可読性は十分です',
      isError: false,
    });

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
    await executeStore({
      filePath,
      checkItemId: 1,
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '可読性は十分です',
      isError: false,
    });

    // 2件目を書き込み
    await executeStore({
      filePath,
      checkItemId: 2,
      ratingLabel: 'B',
      ratingDefinition: '概ね満たしている',
      comment: 'カバレッジは75%です',
      isError: false,
    });

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(2);
    expect(stored[0].checkItemId).toBe(1);
    expect(stored[1].checkItemId).toBe(2);
  });

  it('同じチェック項目IDの結果は上書きされる', async () => {
    createTmpDir();
    // 1回目の書き込み
    await executeStore({
      filePath,
      checkItemId: 1,
      ratingLabel: 'C',
      ratingDefinition: '改善が必要',
      comment: '可読性が低いです',
      isError: false,
    });

    // 同じIDで2回目の書き込み（上書き）
    await executeStore({
      filePath,
      checkItemId: 1,
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '修正後、可読性は十分です',
      isError: false,
    });

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0].ratingLabel).toBe('A');
    expect(stored[0].comment).toBe('修正後、可読性は十分です');
  });

  it('エラー情報を含むレビュー結果を書き込める', async () => {
    createTmpDir();
    const result = await executeStore({
      filePath,
      checkItemId: 3,
      ratingLabel: 'エラー',
      ratingDefinition: 'エラーが発生しました',
      comment: 'Timeout occurred',
      isError: true,
      errorMessage: 'AI API request timed out',
    });

    expect(result.success).toBe(true);

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0].isError).toBe(true);
    expect(stored[0].errorMessage).toBe('AI API request timed out');
  });
});

/**
 * checkItems付きコンテキストでexecuteを呼び出すヘルパー
 */
const executeStoreWithContext = (
  input: {
    filePath: string;
    checkItemId: number;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError: boolean;
    errorMessage?: string;
  },
  checkItems: IndexedCheckItem[],
): Promise<{ success: boolean; message?: string }> => {
  const executeFn = storeReviewResultTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([['checkItems', checkItems]]);
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
        filePath,
        checkItemId: 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'セキュリティは問題ありません',
        isError: false,
      },
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
        filePath,
        checkItemId: 99,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: '問題ありません',
        isError: false,
      },
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
    const executeFn = storeReviewResultTool.execute;
    if (!executeFn) throw new Error('execute is not defined');

    // checkItemsを含まないRequestContext
    const requestContext = new RequestContext([]);
    const context = {
      requestContext,
    } as Parameters<NonNullable<typeof storeReviewResultTool.execute>>[1];

    const result = (await executeFn(
      {
        filePath,
        checkItemId: 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: '問題ありません',
        isError: false,
      },
      context,
    )) as { success: boolean };

    expect(result.success).toBe(true);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
  });
});
