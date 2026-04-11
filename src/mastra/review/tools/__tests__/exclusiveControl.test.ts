import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { storeReviewResultTool } from '../storeReviewResult.js';

/**
 * テスト用のデフォルト評定基準
 */
const defaultRatings = [{ label: 'A', definition: '完全に満たしている' }];

/**
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 * RequestContextにresultFilePathとratingsを設定
 */
const executeStore = (
  input: {
    checkItemId: number;
    ratingLabel: string;
    comment: string;
  },
  resultFilePath: string,
): Promise<{ success: boolean }> => {
  const executeFn = storeReviewResultTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([
    ['resultFilePath', resultFilePath],
    ['ratings', defaultRatings],
  ]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof storeReviewResultTool.execute>>[1];
  return executeFn(input, context) as Promise<{ success: boolean }>;
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
      executeStore(
        {
          checkItemId: i + 1,
          ratingLabel: 'A',
          comment: `コメント${i}`,
        },
        filePath,
      ),
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
