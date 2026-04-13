import { describe, it, expect } from 'vitest';
import {
  getDiffDetailTool,
  OMITTED_FILE_DIFFS_KEY,
  ALL_DIFF_FILE_PATHS_KEY,
} from '../getDiffDetail.js';

/**
 * ツールのexecute関数を呼び出すヘルパー
 * RequestContextをモックしてomittedFileDiffsとallDiffFilePathsを注入する
 */
function executeWithContext(
  input: {
    filePath: string;
    keywords?: string[];
    contextLines?: number;
    startLine?: number;
    maxLines?: number;
  },
  omittedFileDiffs: Map<string, string> | undefined,
  allDiffFilePaths?: Set<string>,
) {
  const context =
    omittedFileDiffs !== undefined
      ? {
          requestContext: {
            get: (key: string) => {
              if (key === OMITTED_FILE_DIFFS_KEY) return omittedFileDiffs;
              if (key === ALL_DIFF_FILE_PATHS_KEY) return allDiffFilePaths;
              return undefined;
            },
          },
        }
      : { requestContext: undefined };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (getDiffDetailTool as any).execute(input, context);
}

const sampleOmittedDiffs = new Map<string, string>([
  [
    'src/index.ts',
    [
      '+const c = 3;',
      '+const d = 4;',
      '+const e = 5;',
      ' const f = 6;',
      '-const g = 7;',
      '+const g = 8;',
      '+function foo() {',
      '+  return "bar";',
      '+}',
    ].join('\n'),
  ],
  [
    'src/utils/helper.ts',
    ['+export function calculate(x: number): number {', '+  return x * 2;', '+}'].join('\n'),
  ],
]);

describe('getDiffDetailTool', () => {
  it('完全一致パスで省略部分を取得できる', async () => {
    const result = await executeWithContext({ filePath: 'src/index.ts' }, sampleOmittedDiffs);
    expect(result.success).toBe(true);
    expect(result.diff).toContain('const c = 3');
    expect(result.diff).toContain('function foo()');
  });

  it('部分一致パスで省略部分を取得できる', async () => {
    const result = await executeWithContext({ filePath: 'utils/helper.ts' }, sampleOmittedDiffs);
    expect(result.success).toBe(true);
    expect(result.diff).toContain('calculate');
  });

  it('diffに存在するが圧縮されていないファイルの場合は適切なメッセージを返す', async () => {
    const allFiles = new Set(['src/index.ts', 'src/utils/helper.ts', 'src/uncompressed.ts']);
    const result = await executeWithContext(
      { filePath: 'src/uncompressed.ts' },
      sampleOmittedDiffs,
      allFiles,
    );
    expect(result.success).toBe(true);
    expect(result.diff).toBe('');
    expect(result.message).toContain('already provided in the prompt');
  });

  it('diffにも存在しないファイルの場合はエラーを返す', async () => {
    const allFiles = new Set(['src/index.ts', 'src/utils/helper.ts']);
    const result = await executeWithContext(
      { filePath: 'src/nonexistent.ts' },
      sampleOmittedDiffs,
      allFiles,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('src/index.ts');
    expect(result.message).toContain('src/utils/helper.ts');
  });

  it('単一キーワードで省略部分内を検索できる', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', keywords: ['foo'] },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    expect(result.diff).toContain('function foo()');
  });

  it('複数キーワードでOR検索できる', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', keywords: ['const d', 'foo'] },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    expect(result.diff).toContain('const d = 4');
    expect(result.diff).toContain('function foo()');
  });

  it('キーワードにマッチしない場合は空のdiffとメッセージを返す', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', keywords: ['nonexistent_keyword'] },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    expect(result.diff).toBe('');
    expect(result.message).toContain('nonexistent_keyword');
  });

  it('contextLinesを指定できる', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', keywords: ['const e'], contextLines: 1 },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    // const e = 5 の前後1行が含まれる
    expect(result.diff).toContain('const d = 4');
    expect(result.diff).toContain('const e = 5');
    expect(result.diff).toContain('const f = 6');
  });

  it('contextLines未指定時はデフォルト3行', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', keywords: ['const e'] },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    // const e = 5 の前後3行（範囲内）が含まれる
    expect(result.diff).toContain('const c = 3');
    expect(result.diff).toContain('const e = 5');
    expect(result.diff).toContain('const g = 8');
  });

  it('omittedFileDiffs自体がない場合はエラーメッセージを返す', async () => {
    const result = await executeWithContext({ filePath: 'src/index.ts' }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toContain('No compressed diff data');
  });

  // --- 出力制限・ページネーション関連のテスト ---

  it('出力に行番号が付与される（workspace形式: 右揃え数値→コンテンツ）', async () => {
    const result = await executeWithContext({ filePath: 'src/index.ts' }, sampleOmittedDiffs);
    expect(result.success).toBe(true);
    // workspace形式: "     1→content"
    expect(result.diff).toMatch(/^\s*1\u2192/m);
    expect(result.totalLines).toBeGreaterThan(0);
    expect(result.shownLines).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
  });

  it('小さい出力ではtruncated=falseで全行が表示される', async () => {
    const result = await executeWithContext({ filePath: 'src/index.ts' }, sampleOmittedDiffs);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(9); // sampleOmittedDiffsの'src/index.ts'は9行
    expect(result.shownLines).toBe(9);
  });

  it('大きな省略diffが切り詰められtruncated=trueになる', async () => {
    // 非常に大きな省略diffを作成
    const largeLines = Array.from({ length: 5000 }, (_, i) => `+const var${i} = ${i};`);
    const largeDiffs = new Map<string, string>([['src/large.ts', largeLines.join('\n')]]);

    const result = await executeWithContext({ filePath: 'src/large.ts' }, largeDiffs);
    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.shownLines).toBeLessThan(result.totalLines);
    expect(result.totalLines).toBe(5000);
    expect(result.diff).toContain('[output truncated:');
  });

  it('startLineで先頭行をスキップできる', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', startLine: 5 },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    // 5行目から開始なので、最初の4行はスキップされる
    // 元の9行のうち5行目以降 = 5行分
    expect(result.totalLines).toBe(9); // 元の総行数
    expect(result.shownLines).toBe(5); // 5行目〜9行目
    // 1行目の内容（const c = 3）が含まれない
    expect(result.diff).not.toContain('const c = 3');
  });

  it('maxLinesで出力行数を制限できる', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', maxLines: 3 },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(3);
  });

  it('startLine + maxLinesでページネーションできる', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', startLine: 3, maxLines: 2 },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(2); // 3行目と4行目のみ
  });

  it('キーワードフィルタ結果にも出力制限が適用される', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', keywords: ['const'] },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    // 出力制限メタデータが存在する
    expect(result.totalLines).toBeDefined();
    expect(result.shownLines).toBeDefined();
    expect(result.truncated).toBeDefined();
  });

  it('diffに存在するが圧縮されていないファイルの場合は出力制限フィールドが含まれない', async () => {
    const allFiles = new Set(['src/index.ts', 'src/utils/helper.ts', 'src/uncompressed.ts']);
    const result = await executeWithContext(
      { filePath: 'src/uncompressed.ts' },
      sampleOmittedDiffs,
      allFiles,
    );
    expect(result.success).toBe(true);
    expect(result.diff).toBe('');
    // 圧縮されていないファイルには出力制限フィールドなし
    expect(result.totalLines).toBeUndefined();
    expect(result.truncated).toBeUndefined();
  });

  it('エラーレスポンスには出力制限フィールドが含まれない', async () => {
    const result = await executeWithContext({ filePath: 'src/index.ts' }, undefined);
    expect(result.success).toBe(false);
    expect(result.totalLines).toBeUndefined();
    expect(result.truncated).toBeUndefined();
  });

  it('startLineが総行数を超える場合は空のdiffを返す', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', startLine: 100 },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(0);
  });

  it('startLine=0の場合は1行目から開始される', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', startLine: 0 },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(9);
    expect(result.diff).toContain('const c = 3');
  });

  it('キーワードフィルタとstartLine/maxLinesを組み合わせてページネーションできる', async () => {
    const result = await executeWithContext(
      { filePath: 'src/index.ts', keywords: ['const'], startLine: 2, maxLines: 2 },
      sampleOmittedDiffs,
    );
    expect(result.success).toBe(true);
    // キーワードフィルタ後のテキスト内で2行目から2行分を取得
    expect(result.shownLines).toBe(2);
  });
});
