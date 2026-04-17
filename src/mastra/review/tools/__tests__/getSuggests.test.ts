import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { getSuggestsTool } from '../getSuggests.js';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';
import type { StoredSuggestion } from '../../suggestTypes.js';

/**
 * テスト用のデフォルトチェック項目
 */
const defaultCheckItems: IndexedCheckItem[] = [
  { id: 1, content: 'セキュリティチェック' },
  { id: 2, content: 'パフォーマンスチェック' },
];

/**
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 */
const executeGetSuggests = (
  options: {
    checkItems?: IndexedCheckItem[];
    suggestResultFilePath?: string | null;
  } = {},
): Promise<{
  suggestions: Array<{
    checkItemId: number;
    checkItemContent: string;
    filePath: string;
    originalCode: string;
    suggestedCode: string;
    comment: string;
  }>;
}> => {
  const executeFn = getSuggestsTool.execute;
  if (!executeFn) throw new Error('execute is not defined');

  const { checkItems = defaultCheckItems, suggestResultFilePath = null } = options;

  const requestContext = new RequestContext([
    ['checkItems', checkItems],
    ['suggestResultFilePath', suggestResultFilePath ?? undefined],
  ]);

  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof getSuggestsTool.execute>>[1];
  return executeFn({}, context) as ReturnType<typeof executeGetSuggests>;
};

describe('getSuggests', () => {
  let tmpDir: string;
  let suggestFilePath: string;

  // テストごとに一時ディレクトリを作成
  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-suggests-'));
    suggestFilePath = path.join(tmpDir, 'suggests.json');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('suggestが存在しない場合は空配列を返す', async () => {
    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      suggestResultFilePath: null,
    });

    expect(result.suggestions).toEqual([]);
  });

  it('チェック項目が空の場合は空配列を返す', async () => {
    const result = await executeGetSuggests({
      checkItems: [],
    });

    expect(result.suggestions).toEqual([]);
  });

  it('checkItemsがundefinedの場合は空配列を返す', async () => {
    const executeFn = getSuggestsTool.execute;
    if (!executeFn) throw new Error('execute is not defined');

    const requestContext = new RequestContext([]);
    const context = {
      requestContext,
    } as Parameters<NonNullable<typeof getSuggestsTool.execute>>[1];

    const result = (await executeFn({}, context)) as { suggestions: unknown[] };
    expect(result.suggestions).toEqual([]);
  });

  it('現在のセッションのsuggestsを返す', async () => {
    createTmpDir();

    const storedSuggestions: StoredSuggestion[] = [
      {
        checkItemId: 1,
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/app.ts',
        originalCode: 'dangerousFunc(input)',
        suggestedCode: 'safeFunc(input)',
        comment: '安全な関数を使用してください',
        newLine: 10,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
      },
    ];
    fs.writeFileSync(suggestFilePath, JSON.stringify(storedSuggestions), 'utf-8');

    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      suggestResultFilePath: suggestFilePath,
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toEqual({
      checkItemId: 1,
      checkItemContent: 'セキュリティチェック',
      filePath: 'src/app.ts',
      originalCode: 'dangerousFunc(input)',
      suggestedCode: 'safeFunc(input)',
      comment: '安全な関数を使用してください',
    });
  });

  it('割り当てられたチェック項目のみでフィルタリングする', async () => {
    createTmpDir();

    // チェック項目1のみを割り当て
    const assignedCheckItems: IndexedCheckItem[] = [{ id: 1, content: 'セキュリティチェック' }];

    const storedSuggestions: StoredSuggestion[] = [
      {
        checkItemId: 1,
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/utils.ts',
        originalCode: 'dangerousFunc(code)',
        suggestedCode: 'safeFunc(code)',
        comment: '対象のsuggest',
        newLine: 5,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/utils.ts',
        newPath: 'src/utils.ts',
      },
      {
        checkItemId: 2,
        checkItemContent: 'パフォーマンスチェック',
        filePath: 'src/heavy.ts',
        originalCode: 'sleep(1000)',
        suggestedCode: 'await delay(1000)',
        comment: '対象外のsuggest',
        newLine: 20,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/heavy.ts',
        newPath: 'src/heavy.ts',
      },
    ];
    fs.writeFileSync(suggestFilePath, JSON.stringify(storedSuggestions), 'utf-8');

    const result = await executeGetSuggests({
      checkItems: assignedCheckItems,
      suggestResultFilePath: suggestFilePath,
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].checkItemContent).toBe('セキュリティチェック');
  });

  it('suggestResultFilePathが存在するがファイルが存在しない場合は空配列を返す', async () => {
    createTmpDir();
    const nonExistentPath = path.join(tmpDir, 'non-existent.json');

    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      suggestResultFilePath: nonExistentPath,
    });

    expect(result.suggestions).toEqual([]);
  });

  it('suggestResultFilePathが未設定の場合は空配列を返す', async () => {
    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      suggestResultFilePath: null,
    });

    expect(result.suggestions).toEqual([]);
  });
});
