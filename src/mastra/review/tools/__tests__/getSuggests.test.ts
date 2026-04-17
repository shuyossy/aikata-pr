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
 * テスト用のactiveSuggestのデフォルト型
 */
type ActiveSuggest = {
  checkItemContent: string;
  filePath: string;
  originalCode: string;
  suggestedCode: string;
  comment: string;
};

/**
 * Mastra Toolのexecuteを型安全に呼び出すヘルパー
 */
const executeGetSuggests = (
  options: {
    checkItems?: IndexedCheckItem[];
    activeSuggests?: ActiveSuggest[] | null;
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
    source: 'prior' | 'current';
  }>;
}> => {
  const executeFn = getSuggestsTool.execute;
  if (!executeFn) throw new Error('execute is not defined');

  const {
    checkItems = defaultCheckItems,
    activeSuggests = null,
    suggestResultFilePath = null,
  } = options;

  const requestContext = new RequestContext([
    ['checkItems', checkItems],
    ['activeSuggests', activeSuggests ?? undefined],
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
      activeSuggests: null,
      suggestResultFilePath: null,
    });

    expect(result.suggestions).toEqual([]);
  });

  it('チェック項目が空の場合は空配列を返す', async () => {
    const result = await executeGetSuggests({
      checkItems: [],
      activeSuggests: [
        {
          checkItemContent: 'セキュリティチェック',
          filePath: 'src/app.ts',
          originalCode: 'const x = 1;',
          suggestedCode: 'const x = 2;',
          comment: 'テスト',
        },
      ],
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

  it('prior active suggestsをsource: "prior"で返す', async () => {
    const activeSuggests: ActiveSuggest[] = [
      {
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/app.ts',
        originalCode: 'const secret = "password";',
        suggestedCode: 'const secret = process.env.SECRET;',
        comment: '環境変数を使用してください',
      },
    ];

    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      activeSuggests,
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toEqual({
      checkItemId: 1,
      checkItemContent: 'セキュリティチェック',
      filePath: 'src/app.ts',
      originalCode: 'const secret = "password";',
      suggestedCode: 'const secret = process.env.SECRET;',
      comment: '環境変数を使用してください',
      source: 'prior',
    });
  });

  it('現在のセッションのsuggestsをsource: "current"で返す', async () => {
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
      source: 'current',
    });
  });

  it('割り当てられたチェック項目のみでフィルタリングする', async () => {
    createTmpDir();

    // チェック項目1のみを割り当て
    const assignedCheckItems: IndexedCheckItem[] = [{ id: 1, content: 'セキュリティチェック' }];

    // activeSuggestsに割り当て外のチェック項目も含む
    const activeSuggests: ActiveSuggest[] = [
      {
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/app.ts',
        originalCode: 'const secret = "password";',
        suggestedCode: 'const secret = process.env.SECRET;',
        comment: '対象のsuggest',
      },
      {
        checkItemContent: 'パフォーマンスチェック',
        filePath: 'src/server.ts',
        originalCode: 'for (let i = 0; i < arr.length; i++)',
        suggestedCode: 'for (const item of arr)',
        comment: '対象外のsuggest',
      },
    ];

    // currentにも割り当て外のチェック項目を含む
    const storedSuggestions: StoredSuggestion[] = [
      {
        checkItemId: 1,
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/utils.ts',
        originalCode: 'dangerousFunc(code)',
        suggestedCode: 'safeFunc(code)',
        comment: '対象のcurrent suggest',
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
        comment: '対象外のcurrent suggest',
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
      activeSuggests,
      suggestResultFilePath: suggestFilePath,
    });

    // セキュリティチェックに該当する2件のみ返る
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.every((s) => s.checkItemContent === 'セキュリティチェック')).toBe(
      true,
    );
    expect(result.suggestions[0].source).toBe('prior');
    expect(result.suggestions[1].source).toBe('current');
  });

  it('priorとcurrentのsuggestsを結合して返す', async () => {
    createTmpDir();

    const activeSuggests: ActiveSuggest[] = [
      {
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/app.ts',
        originalCode: 'const secret = "password";',
        suggestedCode: 'const secret = process.env.SECRET;',
        comment: 'priorのsuggest',
      },
    ];

    const storedSuggestions: StoredSuggestion[] = [
      {
        checkItemId: 2,
        checkItemContent: 'パフォーマンスチェック',
        filePath: 'src/server.ts',
        originalCode: 'arr.forEach(x => process(x))',
        suggestedCode: 'for (const x of arr) process(x)',
        comment: 'currentのsuggest',
        newLine: 15,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/server.ts',
        newPath: 'src/server.ts',
      },
    ];
    fs.writeFileSync(suggestFilePath, JSON.stringify(storedSuggestions), 'utf-8');

    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      activeSuggests,
      suggestResultFilePath: suggestFilePath,
    });

    expect(result.suggestions).toHaveLength(2);

    // priorが先に来る
    expect(result.suggestions[0]).toEqual({
      checkItemId: 1,
      checkItemContent: 'セキュリティチェック',
      filePath: 'src/app.ts',
      originalCode: 'const secret = "password";',
      suggestedCode: 'const secret = process.env.SECRET;',
      comment: 'priorのsuggest',
      source: 'prior',
    });

    // currentが後に来る
    expect(result.suggestions[1]).toEqual({
      checkItemId: 2,
      checkItemContent: 'パフォーマンスチェック',
      filePath: 'src/server.ts',
      originalCode: 'arr.forEach(x => process(x))',
      suggestedCode: 'for (const x of arr) process(x)',
      comment: 'currentのsuggest',
      source: 'current',
    });
  });

  it('suggestResultFilePathが存在するがファイルが存在しない場合はpriorのみ返す', async () => {
    createTmpDir();
    const nonExistentPath = path.join(tmpDir, 'non-existent.json');

    const activeSuggests: ActiveSuggest[] = [
      {
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/app.ts',
        originalCode: 'const x = 1;',
        suggestedCode: 'const x = 2;',
        comment: 'テスト',
      },
    ];

    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      activeSuggests,
      suggestResultFilePath: nonExistentPath,
    });

    // ファイルが存在しなくてもreadStoredSuggestionsは空配列を返す
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].source).toBe('prior');
  });

  it('suggestResultFilePathが未設定の場合はpriorのみ返す', async () => {
    const activeSuggests: ActiveSuggest[] = [
      {
        checkItemContent: 'セキュリティチェック',
        filePath: 'src/app.ts',
        originalCode: 'const x = 1;',
        suggestedCode: 'const x = 2;',
        comment: 'テスト',
      },
    ];

    const result = await executeGetSuggests({
      checkItems: defaultCheckItems,
      activeSuggests,
      suggestResultFilePath: null,
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].source).toBe('prior');
  });
});
