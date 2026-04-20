import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { storeSuggestTool } from '../storeSuggest.js';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';
import type { SuggestionLineResolver } from '../../../../application/shared/port/suggestion/index.js';
import type { StoredSuggestion } from '../../suggestTypes.js';

/**
 * テスト用のデフォルトチェック項目
 */
const defaultCheckItems: IndexedCheckItem[] = [
  { id: 1, content: 'セキュリティチェック' },
  { id: 2, content: 'パフォーマンスチェック' },
];

/**
 * テスト用のデフォルトMRdiff
 */
const defaultMrDiff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,5 @@
 import express from 'express';
-const app = express();
+const app = express(); // updated
 app.listen(3000);
`;

/**
 * 成功を返すモックリゾルバ
 */
const createSuccessResolver = (
  overrides?: Partial<{
    newLine: number;
    linesAbove: number;
    linesBelow: number;
    oldPath: string;
    newPath: string;
  }>,
): SuggestionLineResolver => ({
  resolve: (filePath: string) => ({
    success: true,
    newLine: overrides?.newLine ?? 10,
    linesAbove: overrides?.linesAbove ?? 0,
    linesBelow: overrides?.linesBelow ?? 0,
    oldPath: overrides?.oldPath ?? filePath,
    newPath: overrides?.newPath ?? filePath,
  }),
});

/**
 * エラーを返すモックリゾルバ
 */
const createErrorResolver = (errorMessage: string): SuggestionLineResolver => ({
  resolve: () => ({
    success: false,
    errorMessage,
  }),
});

/**
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 */
const executeStoreSuggest = (
  input: {
    checkItemId: number;
    filePath: string;
    originalCode: string;
    suggestedCode: string;
    comment: string;
  },
  suggestResultFilePath: string,
  options: {
    checkItems?: IndexedCheckItem[];
    suggestionLineResolver?: SuggestionLineResolver | null;
    fullMrDiff?: string | null;
  } = {},
): Promise<{ success: boolean; message?: string }> => {
  const executeFn = storeSuggestTool.execute;
  if (!executeFn) throw new Error('execute is not defined');

  const {
    checkItems = defaultCheckItems,
    suggestionLineResolver = createSuccessResolver(),
    fullMrDiff = defaultMrDiff,
  } = options;

  const requestContext = new RequestContext([
    ['suggestResultFilePath', suggestResultFilePath],
    ['checkItems', checkItems],
    ['suggestionLineResolver', suggestionLineResolver ?? undefined],
    ['fullMrDiff', fullMrDiff ?? undefined],
  ]);

  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof storeSuggestTool.execute>>[1];
  return executeFn(input, context) as Promise<{ success: boolean; message?: string }>;
};

describe('storeSuggest', () => {
  let tmpDir: string;
  let suggestFilePath: string;

  // テストごとに一時ディレクトリを作成
  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-suggest-'));
    suggestFilePath = path.join(tmpDir, 'suggests.json');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('suggestをjsonファイルに書き込める', async () => {
    createTmpDir();
    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // fixed',
        comment: 'コメントを追加しました',
      },
      suggestFilePath,
    );

    expect(result.success).toBe(true);

    const stored: StoredSuggestion[] = JSON.parse(fs.readFileSync(suggestFilePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      checkItemId: 1,
      checkItemContent: 'セキュリティチェック',
      filePath: 'src/app.ts',
      originalCode: 'const app = express();',
      suggestedCode: 'const app = express(); // fixed',
      comment: 'コメントを追加しました',
      newLine: 10,
      linesAbove: 0,
      linesBelow: 0,
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
    });
  });

  it('存在しないcheckItemIdを指定した場合エラーが返される', async () => {
    createTmpDir();
    const result = await executeStoreSuggest(
      {
        checkItemId: 99,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // fixed',
        comment: '修正提案',
      },
      suggestFilePath,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('99');
    expect(result.message).toContain('[ID: 1]');
    expect(result.message).toContain('[ID: 2]');
    // ファイルが作成されていないことを確認
    expect(fs.existsSync(suggestFilePath)).toBe(false);
  });

  it('originalCodeが201行を超える場合エラーが返される', async () => {
    createTmpDir();
    // 202行のコードを生成
    const longCode = Array.from({ length: 202 }, (_, i) => `line ${i + 1}`).join('\n');

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: longCode,
        suggestedCode: 'fixed code',
        comment: '長いコードの修正',
      },
      suggestFilePath,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('202');
    expect(result.message).toContain('201');
    // ファイルが作成されていないことを確認
    expect(fs.existsSync(suggestFilePath)).toBe(false);
  });

  it('originalCodeがちょうど201行の場合は正常に保存される', async () => {
    createTmpDir();
    const exactCode = Array.from({ length: 201 }, (_, i) => `line ${i + 1}`).join('\n');

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: exactCode,
        suggestedCode: 'fixed code',
        comment: 'ちょうど201行のコード',
      },
      suggestFilePath,
    );

    expect(result.success).toBe(true);
  });

  it('現在のセッションで同じfilePath+originalCodeの場合は重複エラーが返される', async () => {
    createTmpDir();

    // 1件目を書き込み
    await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // first',
        comment: '1件目',
      },
      suggestFilePath,
    );

    // 同じfilePath+originalCodeで2件目を書き込み
    const result = await executeStoreSuggest(
      {
        checkItemId: 2,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // second',
        comment: '2件目（重複）',
      },
      suggestFilePath,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('already been stored in this session');
  });

  it('行番号解決に失敗した場合（コードが見つからない）エラーが返される', async () => {
    createTmpDir();
    const errorResolver = createErrorResolver(
      'originalCode not found in the diff for file src/app.ts. Make sure originalCode is an exact copy from the new side of the diff.',
    );

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'nonexistent code',
        suggestedCode: 'fixed code',
        comment: '存在しないコード',
      },
      suggestFilePath,
      { suggestionLineResolver: errorResolver },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('originalCode not found');
  });

  it('行番号解決に失敗した場合（複数マッチ）エラーが返される', async () => {
    createTmpDir();
    const errorResolver = createErrorResolver(
      'originalCode matches multiple locations in the diff for file src/app.ts. Include more context lines for unique identification.',
    );

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'ambiguous code',
        suggestedCode: 'fixed code',
        comment: '曖昧なコード',
      },
      suggestFilePath,
      { suggestionLineResolver: errorResolver },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('matches multiple locations');
  });

  it('行番号解決の結果が正しく保存される', async () => {
    createTmpDir();
    const resolver = createSuccessResolver({
      newLine: 42,
      linesAbove: 3,
      linesBelow: 2,
      oldPath: 'src/old-app.ts',
      newPath: 'src/new-app.ts',
    });

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // fixed',
        comment: '行番号解決テスト',
      },
      suggestFilePath,
      { suggestionLineResolver: resolver },
    );

    expect(result.success).toBe(true);

    const stored: StoredSuggestion[] = JSON.parse(fs.readFileSync(suggestFilePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0].newLine).toBe(42);
    expect(stored[0].linesAbove).toBe(3);
    expect(stored[0].linesBelow).toBe(2);
    expect(stored[0].oldPath).toBe('src/old-app.ts');
    expect(stored[0].newPath).toBe('src/new-app.ts');
  });

  it('複数のsuggestが正しく保存される', async () => {
    createTmpDir();

    // 1件目
    const result1 = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // fixed',
        comment: '1件目の修正',
      },
      suggestFilePath,
    );
    expect(result1.success).toBe(true);

    // 2件目（異なるファイル）
    const result2 = await executeStoreSuggest(
      {
        checkItemId: 2,
        filePath: 'src/server.ts',
        originalCode: 'app.listen(3000);',
        suggestedCode: 'app.listen(PORT);',
        comment: '2件目の修正',
      },
      suggestFilePath,
    );
    expect(result2.success).toBe(true);

    const stored: StoredSuggestion[] = JSON.parse(fs.readFileSync(suggestFilePath, 'utf-8'));
    expect(stored).toHaveLength(2);
    expect(stored[0].checkItemId).toBe(1);
    expect(stored[0].filePath).toBe('src/app.ts');
    expect(stored[0].checkItemContent).toBe('セキュリティチェック');
    expect(stored[1].checkItemId).toBe(2);
    expect(stored[1].filePath).toBe('src/server.ts');
    expect(stored[1].checkItemContent).toBe('パフォーマンスチェック');
  });

  it('行番号解決失敗時のメッセージにリトライ誘導文言が含まれる', async () => {
    createTmpDir();
    const errorResolver = createErrorResolver(
      "Code not found in diff for file 'src/app.ts' even after ignoring all whitespace.",
    );

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'nonexistent code',
        suggestedCode: 'fixed code',
        comment: 'テスト',
      },
      suggestFilePath,
      { suggestionLineResolver: errorResolver },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('You SHOULD retry');
  });

  it('共通先頭行・末尾行がある場合トリミングされて保存される', async () => {
    createTmpDir();
    const resolver = createSuccessResolver({
      newLine: 10,
      linesAbove: 0,
      linesBelow: 4,
    });

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: ['common1', 'common2', 'OLD_LINE', 'common3', 'common4'].join('\n'),
        suggestedCode: ['common1', 'common2', 'NEW_LINE', 'common3', 'common4'].join('\n'),
        comment: 'トリミングテスト',
      },
      suggestFilePath,
      { suggestionLineResolver: resolver },
    );

    expect(result.success).toBe(true);

    const stored: StoredSuggestion[] = JSON.parse(fs.readFileSync(suggestFilePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    // トリミング後: 先頭2行除去、末尾2行除去
    expect(stored[0].originalCode).toBe('OLD_LINE');
    expect(stored[0].suggestedCode).toBe('NEW_LINE');
    // newLine = 10 + 2（先頭除去行数）= 12
    expect(stored[0].newLine).toBe(12);
    // linesBelow = トリミング後originalCode行数(1) - 1 = 0
    expect(stored[0].linesBelow).toBe(0);
  });

  it('共通行がない場合はトリミングせず元のまま保存される', async () => {
    createTmpDir();
    const resolver = createSuccessResolver({
      newLine: 10,
      linesAbove: 0,
      linesBelow: 0,
    });

    const result = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // fixed',
        comment: 'トリミング不要テスト',
      },
      suggestFilePath,
      { suggestionLineResolver: resolver },
    );

    expect(result.success).toBe(true);

    const stored: StoredSuggestion[] = JSON.parse(fs.readFileSync(suggestFilePath, 'utf-8'));
    expect(stored).toHaveLength(1);
    expect(stored[0].originalCode).toBe('const app = express();');
    expect(stored[0].suggestedCode).toBe('const app = express(); // fixed');
    expect(stored[0].newLine).toBe(10);
    expect(stored[0].linesBelow).toBe(0);
  });

  it('resolverまたはfullMrDiffが未設定の場合エラーが返される', async () => {
    createTmpDir();

    // resolverなし
    const result1 = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // fixed',
        comment: 'テスト',
      },
      suggestFilePath,
      { suggestionLineResolver: null },
    );
    expect(result1.success).toBe(false);
    expect(result1.message).toContain('not available');

    // fullMrDiffなし
    const result2 = await executeStoreSuggest(
      {
        checkItemId: 1,
        filePath: 'src/app.ts',
        originalCode: 'const app = express();',
        suggestedCode: 'const app = express(); // fixed',
        comment: 'テスト',
      },
      suggestFilePath,
      { fullMrDiff: null },
    );
    expect(result2.success).toBe(false);
    expect(result2.message).toContain('not available');
  });
});
