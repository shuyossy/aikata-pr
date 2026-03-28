import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeReviewResultTool } from '../storeReviewResult.js';

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

describe('排他制御', () => {
  let tmpDir: string;
  let filePath: string;

  // テストごとに一時ディレクトリを作成
  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclusive-control-'));
    filePath = path.join(tmpDir, 'results.json');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('同時に複数のstoreReviewResult呼び出しが競合しない', async () => {
    createTmpDir();
    const concurrentCount = 10;

    // 同時に複数のstoreReviewResultを呼び出し
    const promises = Array.from({ length: concurrentCount }, (_, i) =>
      executeStore({
        filePath,
        checkItemId: i + 1,
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: `コメント${i}`,
        isError: false,
      }),
    );

    const results = await Promise.all(promises);

    // 全ての呼び出しが成功していること
    expect(results.every((r) => r.success)).toBe(true);

    // 全件が保存されていること
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(stored).toHaveLength(concurrentCount);

    // 全てのチェック項目IDが含まれていること
    const ids = stored.map((r: { checkItemId: number }) => r.checkItemId);
    for (let i = 0; i < concurrentCount; i++) {
      expect(ids).toContain(i + 1);
    }
  });
});
