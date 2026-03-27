import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeReviewResultTool } from '../storeReviewResult.js';

/**
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 * execute は Mastra の型定義上 undefined の可能性があるため非null断定で呼び出す
 */
const executeStore = (input: {
  filePath: string;
  checkItemContent: string;
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
      checkItemContent: 'コードの可読性',
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '可読性は十分です',
      isError: false,
    });

    expect(result.success).toBe(true);

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      checkItemContent: 'コードの可読性',
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
      checkItemContent: 'コードの可読性',
      ratingLabel: 'A',
      ratingDefinition: '完全に満たしている',
      comment: '可読性は十分です',
      isError: false,
    });

    // 2件目を書き込み
    await executeStore({
      filePath,
      checkItemContent: 'テストカバレッジ',
      ratingLabel: 'B',
      ratingDefinition: '概ね満たしている',
      comment: 'カバレッジは75%です',
      isError: false,
    });

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(2);
    expect(stored[0].checkItemContent).toBe('コードの可読性');
    expect(stored[1].checkItemContent).toBe('テストカバレッジ');
  });

  it('同じチェック項目の結果は上書きされる', async () => {
    createTmpDir();
    // 1回目の書き込み
    await executeStore({
      filePath,
      checkItemContent: 'コードの可読性',
      ratingLabel: 'C',
      ratingDefinition: '改善が必要',
      comment: '可読性が低いです',
      isError: false,
    });

    // 同じチェック項目で2回目の書き込み（上書き）
    await executeStore({
      filePath,
      checkItemContent: 'コードの可読性',
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
      checkItemContent: 'セキュリティチェック',
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
