import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { getReviewResultsTool } from '../getReviewResults.js';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';

/**
 * レビュー結果の型
 */
interface ReviewResultEntry {
  checkItemId: number;
  ratingLabel: string;
  ratingDefinition: string;
  comment: string;
  isError: boolean;
  errorMessage?: string;
}

/**
 * テスト用のレビュー結果をJSONファイルに直接書き込むヘルパー
 */
function writeResults(filePath: string, results: ReviewResultEntry[]): void {
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');
}

/**
 * resultFilePath付きコンテキストでexecuteを呼び出すヘルパー
 */
const executeGet = (resultFilePath: string): Promise<{ results: ReviewResultEntry[] }> => {
  const executeFn = getReviewResultsTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([['resultFilePath', resultFilePath]]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof getReviewResultsTool.execute>>[1];
  return executeFn({}, context) as Promise<{ results: ReviewResultEntry[] }>;
};

/**
 * checkItems付きコンテキストでexecuteを呼び出すヘルパー
 */
const executeGetWithContext = (
  resultFilePath: string,
  checkItems: IndexedCheckItem[],
): Promise<{ results: ReviewResultEntry[] }> => {
  const executeFn = getReviewResultsTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([
    ['resultFilePath', resultFilePath],
    ['checkItems', checkItems],
  ]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof getReviewResultsTool.execute>>[1];
  return executeFn({}, context) as Promise<{ results: ReviewResultEntry[] }>;
};

describe('getReviewResults', () => {
  let tmpDir: string;
  let filePath: string;

  // テストごとに一時ディレクトリを作成
  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-review-results-'));
    filePath = path.join(tmpDir, 'results.json');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('格納済みのレビュー結果一覧を取得できる', async () => {
    createTmpDir();

    // 事前にレビュー結果を直接書き込み
    writeResults(filePath, [
      {
        checkItemId: 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: '可読性は十分です',
        isError: false,
      },
      {
        checkItemId: 2,
        ratingLabel: 'B',
        ratingDefinition: '概ね満たしている',
        comment: 'カバレッジは75%です',
        isError: false,
      },
    ]);

    const result = await executeGet(filePath);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      checkItemId: 1,
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '可読性は十分です',
      isError: false,
    });
    expect(result.results[1]).toEqual({
      checkItemId: 2,
      ratingLabel: 'B',
      ratingDefinition: '概ね満たしている',
      comment: 'カバレッジは75%です',
      isError: false,
    });
  });

  it('結果がない場合は空配列を返す', async () => {
    createTmpDir();

    const result = await executeGet(filePath);

    expect(result.results).toEqual([]);
  });
});

describe('getReviewResults - チェック項目IDフィルタリング', () => {
  let tmpDir: string;
  let filePath: string;

  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-review-results-filter-'));
    filePath = path.join(tmpDir, 'results.json');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('担当チェック項目の結果のみ返される', async () => {
    createTmpDir();

    // 4件の結果を直接書き込み
    writeResults(filePath, [
      {
        checkItemId: 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント1',
        isError: false,
      },
      {
        checkItemId: 2,
        ratingLabel: 'B',
        ratingDefinition: '概ね満たしている',
        comment: 'コメント2',
        isError: false,
      },
      {
        checkItemId: 3,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント3',
        isError: false,
      },
      {
        checkItemId: 4,
        ratingLabel: 'C',
        ratingDefinition: '要件を満たしていない',
        comment: 'コメント4',
        isError: false,
      },
    ]);

    const checkItems: IndexedCheckItem[] = [
      { id: 2, content: 'パフォーマンスチェック' },
      { id: 3, content: 'セキュリティチェック' },
    ];

    const result = await executeGetWithContext(filePath, checkItems);

    expect(result.results).toHaveLength(2);
    expect(result.results[0].checkItemId).toBe(2);
    expect(result.results[1].checkItemId).toBe(3);
  });

  it('担当外の結果がファイルにあっても除外される', async () => {
    createTmpDir();

    writeResults(filePath, [
      {
        checkItemId: 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント1',
        isError: false,
      },
      {
        checkItemId: 5,
        ratingLabel: 'B',
        ratingDefinition: '概ね満たしている',
        comment: 'コメント5',
        isError: false,
      },
    ]);

    const checkItems: IndexedCheckItem[] = [
      { id: 2, content: 'パフォーマンスチェック' },
      { id: 3, content: 'セキュリティチェック' },
    ];

    const result = await executeGetWithContext(filePath, checkItems);

    expect(result.results).toEqual([]);
  });

  it('担当チェック項目の一部のみ結果がある場合、その分だけ返される', async () => {
    createTmpDir();

    writeResults(filePath, [
      {
        checkItemId: 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント1',
        isError: false,
      },
    ]);

    const checkItems: IndexedCheckItem[] = [
      { id: 1, content: 'コード品質チェック' },
      { id: 2, content: 'パフォーマンスチェック' },
    ];

    const result = await executeGetWithContext(filePath, checkItems);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].checkItemId).toBe(1);
  });

  it('RequestContextにcheckItemsがない場合、全結果が返される', async () => {
    createTmpDir();

    writeResults(filePath, [
      {
        checkItemId: 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント1',
        isError: false,
      },
      {
        checkItemId: 2,
        ratingLabel: 'B',
        ratingDefinition: '概ね満たしている',
        comment: 'コメント2',
        isError: false,
      },
      {
        checkItemId: 3,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: 'コメント3',
        isError: false,
      },
    ]);

    // checkItemsなし、resultFilePathのみのコンテキスト
    const result = await executeGet(filePath);

    expect(result.results).toHaveLength(3);
  });

  it('結果がない場合、コンテキスト付きでも空配列を返す', async () => {
    createTmpDir();

    const checkItems: IndexedCheckItem[] = [
      { id: 1, content: 'コード品質チェック' },
      { id: 2, content: 'パフォーマンスチェック' },
    ];

    const result = await executeGetWithContext(filePath, checkItems);

    expect(result.results).toEqual([]);
  });
});
