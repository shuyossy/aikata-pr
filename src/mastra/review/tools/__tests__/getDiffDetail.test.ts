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
  input: { filePath: string; keywords?: string[]; contextLines?: number },
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
});
