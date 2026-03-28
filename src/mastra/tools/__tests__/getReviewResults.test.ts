import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getReviewResultsTool } from '../getReviewResults.js';
import { storeReviewResultTool } from '../storeReviewResult.js';

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
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 * Mastra の型定義上 execute が undefined の可能性があるため安全に呼び出す
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
  const executeFn = storeReviewResultTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  return executeFn(
    input,
    {} as Parameters<NonNullable<typeof storeReviewResultTool.execute>>[1],
  ) as Promise<{ success: boolean }>;
};

const executeGet = (input: { filePath: string }): Promise<{ results: ReviewResultEntry[] }> => {
  const executeFn = getReviewResultsTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  return executeFn(
    input,
    {} as Parameters<NonNullable<typeof getReviewResultsTool.execute>>[1],
  ) as Promise<{ results: ReviewResultEntry[] }>;
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

    // 事前にレビュー結果を格納
    await executeStore({
      filePath,
      checkItemId: 1,
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '可読性は十分です',
      isError: false,
    });

    await executeStore({
      filePath,
      checkItemId: 2,
      ratingLabel: 'B',
      ratingDefinition: '概ね満たしている',
      comment: 'カバレッジは75%です',
      isError: false,
    });

    const result = await executeGet({ filePath });

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

    const result = await executeGet({ filePath });

    expect(result.results).toEqual([]);
  });
});
