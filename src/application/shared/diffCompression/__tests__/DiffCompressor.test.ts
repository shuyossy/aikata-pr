import { describe, it, expect } from 'vitest';
import {
  splitDiffByFile,
  compressFileDiff,
  compressFileDiffByLines,
  combineFileDiffs,
  compressDiffIfNeeded,
} from '../DiffCompressor.js';
import type { TokenCounter } from '../../port/tokenCounter/index.js';

// テスト用のシンプルなTokenCounter（1文字=1トークンとして扱う）
class CharTokenCounter implements TokenCounter {
  countTokens(text: string): number {
    return text.length;
  }
}

// テスト用のdiffデータ
const singleFileDiff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,10 @@
+import { foo } from './foo';
 const a = 1;
 const b = 2;
+const c = 3;
+const d = 4;
+const e = 5;
 const f = 6;
-const g = 7;
+const g = 8;`;

const multiFileDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,5 +1,6 @@
 b-line1
 b-line2
+b-line2.5
 b-line3
 b-line4
 b-line5`;

const renameDiff = `diff --git a/old/path.ts b/new/path.ts
similarity index 90%
rename from old/path.ts
rename to new/path.ts
--- a/old/path.ts
+++ b/new/path.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3`;

describe('splitDiffByFile', () => {
  it('単一ファイルのdiffを正しく分割する', () => {
    const result = splitDiffByFile(singleFileDiff);
    expect(result.size).toBe(1);
    expect(result.has('src/index.ts')).toBe(true);
    expect(result.get('src/index.ts')).toContain('diff --git');
  });

  it('複数ファイルのdiffを正しく分割する', () => {
    const result = splitDiffByFile(multiFileDiff);
    expect(result.size).toBe(2);
    expect(result.has('src/a.ts')).toBe(true);
    expect(result.has('src/b.ts')).toBe(true);
    expect(result.get('src/a.ts')).toContain('line2-modified');
    expect(result.get('src/b.ts')).toContain('b-line2.5');
  });

  it('リネームされたファイルのパスをb/側から取得する', () => {
    const result = splitDiffByFile(renameDiff);
    expect(result.size).toBe(1);
    expect(result.has('new/path.ts')).toBe(true);
  });

  it('空文字列の場合は空のMapを返す', () => {
    const result = splitDiffByFile('');
    expect(result.size).toBe(0);
  });
});

describe('compressFileDiff', () => {
  // 20行のdiffを生成
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(`line${i}`);
  }
  const twentyLineDiff = lines.join('\n');

  it('keepPercent=30で上位30%と下位30%を保持する', () => {
    const result = compressFileDiff(twentyLineDiff, 30);
    // 20行の30% = 6行。上6行 + 下6行を保持、中間8行を省略
    expect(result.compressed).toContain('line1');
    expect(result.compressed).toContain('line6');
    expect(result.compressed).toContain('line15');
    expect(result.compressed).toContain('line20');
    expect(result.compressed).toContain('[aikata:');
    expect(result.compressed).toContain('8 lines omitted');

    // 省略部分は中間の8行
    expect(result.omitted).toContain('line7');
    expect(result.omitted).toContain('line14');
    // 上位6行（line1〜line6）と下位6行（line15〜line20）は省略部分に含まれない
    const omittedLines = result.omitted.split('\n');
    expect(omittedLines[0]).toBe('line7');
    expect(omittedLines[omittedLines.length - 1]).toBe('line14');
  });

  it('行数が少なく圧縮不要の場合はそのまま返す', () => {
    const shortDiff = 'line1\nline2\nline3';
    const result = compressFileDiff(shortDiff, 30);
    expect(result.compressed).toBe(shortDiff);
    expect(result.omitted).toBe('');
  });

  it('keepPercent=50の場合は圧縮不要（上50%+下50%=100%）', () => {
    const result = compressFileDiff(twentyLineDiff, 50);
    expect(result.compressed).toBe(twentyLineDiff);
    expect(result.omitted).toBe('');
  });

  it('keepPercent=5で大幅に圧縮する', () => {
    const result = compressFileDiff(twentyLineDiff, 5);
    // 20行の5% = 1行。上1行 + 下1行を保持、中間18行を省略
    expect(result.compressed).toContain('line1');
    expect(result.compressed).toContain('line20');
    expect(result.compressed).toContain('18 lines omitted');
    expect(result.omitted).toContain('line2');
    expect(result.omitted).toContain('line19');
  });
});

describe('compressFileDiffByLines', () => {
  // 20行のdiffを生成
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(`line${i}`);
  }
  const twentyLineDiff = lines.join('\n');

  it('keepLines=3で上位3行と下位3行を保持する', () => {
    const result = compressFileDiffByLines(twentyLineDiff, 3);
    // 上3行 + 下3行を保持、中間14行を省略
    expect(result.compressed).toContain('line1');
    expect(result.compressed).toContain('line3');
    expect(result.compressed).toContain('line18');
    expect(result.compressed).toContain('line20');
    expect(result.compressed).toContain('[aikata:');
    expect(result.compressed).toContain('14 lines omitted');

    // 省略部分
    expect(result.omitted).toContain('line4');
    expect(result.omitted).toContain('line17');
    const omittedLines = result.omitted.split('\n');
    expect(omittedLines[0]).toBe('line4');
    expect(omittedLines[omittedLines.length - 1]).toBe('line17');
  });

  it('keepLines=1で上位1行と下位1行を保持する', () => {
    const result = compressFileDiffByLines(twentyLineDiff, 1);
    // 上1行 + 下1行を保持、中間18行を省略
    expect(result.compressed).toContain('line1');
    expect(result.compressed).toContain('line20');
    expect(result.compressed).toContain('18 lines omitted');
    expect(result.omitted).toContain('line2');
    expect(result.omitted).toContain('line19');
  });

  it('keepLines=0でdiff --gitヘッダー行のみ保持する', () => {
    const diffWithHeader = [
      'diff --git a/src/file.ts b/src/file.ts',
      'index 1234567..abcdefg 100644',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,3 +1,3 @@',
      '+code',
    ].join('\n');

    const result = compressFileDiffByLines(diffWithHeader, 0);
    // ヘッダー行のみ保持
    expect(result.compressed).toContain('diff --git a/src/file.ts b/src/file.ts');
    expect(result.compressed).toContain('[aikata:');
    expect(result.compressed).toContain('5 lines omitted');
    // 2行目以降が全てomittedに
    expect(result.omitted).toContain('index 1234567..abcdefg 100644');
    expect(result.omitted).toContain('+code');
    // ヘッダー行はomittedに含まれない
    expect(result.omitted).not.toContain('diff --git');
  });

  it('keepLines=0で1行のみのdiffの場合は圧縮不要', () => {
    const singleLine = 'diff --git a/src/file.ts b/src/file.ts';
    const result = compressFileDiffByLines(singleLine, 0);
    expect(result.compressed).toBe(singleLine);
    expect(result.omitted).toBe('');
  });

  it('keepLines * 2 >= totalLinesの場合は圧縮不要', () => {
    const fourLineDiff = 'line1\nline2\nline3\nline4';
    const result = compressFileDiffByLines(fourLineDiff, 3);
    // 3 * 2 = 6 >= 4 → 圧縮不要
    expect(result.compressed).toBe(fourLineDiff);
    expect(result.omitted).toBe('');
  });

  it('省略マーカーのフォーマットが既存のcompressFileDiffと一致する', () => {
    const result = compressFileDiffByLines(twentyLineDiff, 3);
    expect(result.compressed).toContain(
      '[aikata: 14 lines omitted from middle. Use getDiffDetail tool with file path to view omitted portion]',
    );
  });
});

describe('combineFileDiffs', () => {
  it('ファイルごとのdiffを結合する', () => {
    const fileDiffs = new Map<string, string>([
      ['src/a.ts', 'diff for a'],
      ['src/b.ts', 'diff for b'],
    ]);
    const result = combineFileDiffs(fileDiffs);
    expect(result).toContain('diff for a');
    expect(result).toContain('diff for b');
  });

  it('空のMapの場合は空文字列を返す', () => {
    expect(combineFileDiffs(new Map())).toBe('');
  });
});

describe('compressDiffIfNeeded', () => {
  const tokenCounter = new CharTokenCounter();
  const defaultOptions = {
    maxContextLength: 1000,
    thresholdRatio: 0.6,
    initialKeepPercent: 30,
    keepPercentStep: 5,
    minKeepPercent: 5,
  };

  // シンプルなuserPromptBuilder: diff + folderTreeを連結
  const userPromptBuilder = (diff: string, folderTree: string): string => {
    return `## Folder Tree\n${folderTree}\n## Diff\n${diff}`;
  };

  it('閾値以下の場合はcompressed=falseで元のdiffを返す', () => {
    const result = compressDiffIfNeeded(
      userPromptBuilder,
      'short diff',
      'src/',
      tokenCounter,
      defaultOptions,
    );
    expect(result.compressed).toBe(false);
    expect(result.compressedDiff).toBe('short diff');
  });

  it('Step1: フォルダツリーのファイル除去で閾値以下になる場合', () => {
    // フォルダツリーが大きくてdiffは小さい
    const bigFolderTree = Array.from({ length: 100 }, (_, i) => `  file${i}.ts`).join('\n');
    const folderTree = `src/\n${bigFolderTree}`;
    const diff = 'small diff content';

    const result = compressDiffIfNeeded(userPromptBuilder, diff, folderTree, tokenCounter, {
      ...defaultOptions,
      maxContextLength: 200,
    });
    expect(result.compressed).toBe(true);
    expect(result.folderTreeStripped).toBe(true);
    expect(result.strippedFolderTree).toBe('src/');
    expect(result.compressedDiff).toBe(diff);
  });

  it('Step2: diff圧縮で閾値以下になる場合', () => {
    // 大きなdiffを生成（1ファイル、50行）
    const diffLines: string[] = [];
    for (let i = 0; i < 50; i++) {
      diffLines.push(`+added line number ${i} with some padding content here`);
    }
    const bigDiff = `diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n${diffLines.join('\n')}`;

    const result = compressDiffIfNeeded(userPromptBuilder, bigDiff, 'src/', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 500,
    });

    expect(result.compressed).toBe(true);
    expect(result.compressedDiff).toContain('[aikata:');
    expect(result.omittedFileDiffs.size).toBeGreaterThan(0);
    expect(result.compressedFilePaths.has('src/big.ts')).toBe(true);
  });

  it('Step2: 複数ファイルの場合、最大のファイルから順に圧縮される', () => {
    // 大きいファイルと小さいファイル
    const bigLines = Array.from({ length: 40 }, (_, i) => `+big line ${i} padding`).join('\n');
    const smallLines = Array.from({ length: 5 }, (_, i) => `+small line ${i}`).join('\n');
    const diff = [
      `diff --git a/src/small.ts b/src/small.ts`,
      `--- a/src/small.ts`,
      `+++ b/src/small.ts`,
      smallLines,
      `diff --git a/src/big.ts b/src/big.ts`,
      `--- a/src/big.ts`,
      `+++ b/src/big.ts`,
      bigLines,
    ].join('\n');

    const result = compressDiffIfNeeded(userPromptBuilder, diff, '', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 600,
    });

    expect(result.compressed).toBe(true);
    // 大きいファイルが先に圧縮される
    expect(result.compressedFilePaths.has('src/big.ts')).toBe(true);
  });

  it('Step2: 同一ファイルが再度最大になった場合、keepPercentを減少させて再圧縮する', () => {
    // 1つだけ非常に大きなファイル → 1回の圧縮では閾値以下にならない
    const hugeLines = Array.from(
      { length: 200 },
      (_, i) => `+huge line number ${i} with lots of padding content`,
    ).join('\n');
    const diff = `diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n${hugeLines}`;

    const result = compressDiffIfNeeded(userPromptBuilder, diff, '', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 300,
      initialKeepPercent: 30,
      keepPercentStep: 10,
      minKeepPercent: 5,
    });

    expect(result.compressed).toBe(true);
    // keepPercentが30→20→10→5と減少して再圧縮される
    expect(result.compressedFilePaths.has('src/huge.ts')).toBe(true);
    // 圧縮後のdiffは元よりかなり短い
    expect(result.compressedDiff.length).toBeLessThan(diff.length);
  });

  it('全ファイルがminKeepPercentでもベストエフォートで完了する', () => {
    // 極端に小さいmaxContextLength → 完全に収まらない
    const hugeLines = Array.from({ length: 100 }, (_, i) => `+line ${i} padding`).join('\n');
    const diff = `diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n${hugeLines}`;

    const result = compressDiffIfNeeded(userPromptBuilder, diff, '', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 50,
    });

    // ベストエフォートで圧縮結果を返す
    expect(result.compressed).toBe(true);
    expect(result.compressedDiff.length).toBeLessThan(diff.length);
  });
});

describe('compressDiffIfNeeded - Phase 2 (行数ベース圧縮)', () => {
  const tokenCounter = new CharTokenCounter();
  const defaultOptions = {
    maxContextLength: 1000,
    thresholdRatio: 0.6,
    initialKeepPercent: 30,
    keepPercentStep: 5,
    minKeepPercent: 5,
  };

  const userPromptBuilder = (diff: string, folderTree: string): string => {
    return `## Folder Tree\n${folderTree}\n## Diff\n${diff}`;
  };

  it('Phase 1の5%では不十分で、Phase 2のkeepLines半減で閾値以下になる', () => {
    // 1000行のファイル: Phase 1の5%だと上50行+下50行=100行+マーカー
    // Phase 2で半減を繰り返して閾値以下にする
    const hugeLines = Array.from(
      { length: 1000 },
      (_, i) => `+huge line number ${i} with lots of extra padding content to make it large enough`,
    ).join('\n');
    const diff = `diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n${hugeLines}`;

    // Phase 1の5%（100行保持）では収まらないが、Phase 2で半減すれば収まるmaxContextLength
    // userPromptBuilderのオーバーヘッド（"## Folder Tree\n\n## Diff\n"=約30文字）を考慮
    // Phase 1の5%: 上50行+下50行 ≒ 各行約80文字 × 100行 = 8000文字 + マーカー
    // Phase 2で25行まで下げると: 上25行+下25行 ≒ 50行 × 80文字 = 4000文字 + マーカー
    const result = compressDiffIfNeeded(userPromptBuilder, diff, '', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 8000,
    });

    expect(result.compressed).toBe(true);
    expect(result.compressedFilePaths.has('src/huge.ts')).toBe(true);
    // Phase 2で閾値以下に圧縮されたことを確認
    const promptLength = userPromptBuilder(result.compressedDiff, '').length;
    expect(promptLength).toBeLessThanOrEqual(8000 * 0.6);
  });

  it('Phase 2で複数ファイルがある場合、最大ファイルから順に圧縮される', () => {
    // 2ファイル: 大ファイル500行、小ファイル100行
    const bigLines = Array.from(
      { length: 500 },
      (_, i) => `+big line ${i} with extra padding content here to ensure size`,
    ).join('\n');
    const smallLines = Array.from({ length: 100 }, (_, i) => `+small line ${i} with padding`).join(
      '\n',
    );
    const diff = [
      `diff --git a/src/small.ts b/src/small.ts`,
      `--- a/src/small.ts`,
      `+++ b/src/small.ts`,
      smallLines,
      `diff --git a/src/big.ts b/src/big.ts`,
      `--- a/src/big.ts`,
      `+++ b/src/big.ts`,
      bigLines,
    ].join('\n');

    // Phase 1の5%では収まらない程度に小さいmaxContextLength
    const result = compressDiffIfNeeded(userPromptBuilder, diff, '', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 5000,
    });

    expect(result.compressed).toBe(true);
    // 大きいファイルが圧縮されている
    expect(result.compressedFilePaths.has('src/big.ts')).toBe(true);
    // 大きいファイルのomittedの方が多いことを確認
    const bigOmitted = result.omittedFileDiffs.get('src/big.ts') ?? '';
    const smallOmitted = result.omittedFileDiffs.get('src/small.ts') ?? '';
    expect(bigOmitted.length).toBeGreaterThan(smallOmitted.length);
  });

  it('Phase 2で全ファイルがkeepLines=0に達してもベストエフォートで完了する', () => {
    // 極端に小さいmaxContextLength
    const hugeLines = Array.from(
      { length: 500 },
      (_, i) => `+line ${i} with lots of padding content to ensure very large file`,
    ).join('\n');
    const diff = `diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n${hugeLines}`;

    const result = compressDiffIfNeeded(userPromptBuilder, diff, '', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 10,
    });

    // ベストエフォート: ヘッダー行のみまで圧縮される
    expect(result.compressed).toBe(true);
    expect(result.compressedDiff).toContain('diff --git a/src/huge.ts b/src/huge.ts');
    expect(result.compressedDiff).toContain('[aikata:');
    // Phase 1よりもさらに短い（Phase 2が実行されている）
    // Phase 1の5%: 上25行+下25行 = 50行分
    // Phase 2のヘッダーのみ: 1行+マーカー = 2行分
    const compressedLines = result.compressedDiff.split('\n');
    // ヘッダー行 + 省略マーカーのみ（2行）
    expect(compressedLines.length).toBeLessThanOrEqual(2);
  });

  it('Phase 2の結果がomittedFileDiffsに正しく反映される', () => {
    const hugeLines = Array.from({ length: 500 }, (_, i) => `+line ${i} content`).join('\n');
    const diff = `diff --git a/src/huge.ts b/src/huge.ts\n--- a/src/huge.ts\n+++ b/src/huge.ts\n${hugeLines}`;

    const result = compressDiffIfNeeded(userPromptBuilder, diff, '', tokenCounter, {
      ...defaultOptions,
      maxContextLength: 1000,
    });

    expect(result.compressed).toBe(true);
    // omittedFileDiffsに省略された内容が格納されている
    const omitted = result.omittedFileDiffs.get('src/huge.ts');
    expect(omitted).toBeDefined();
    // 省略部分にはオリジナルdiffの内容が含まれる
    expect(omitted).toContain('+line');
    // 省略部分の行数 + compressedDiffの行数 ≒ オリジナルの行数（マーカー行分の差異あり）
    const originalLines = diff.split('\n').length;
    const compressedLines = result.compressedDiff.split('\n').length;
    const omittedLines = omitted!.split('\n').length;
    // マーカー行1行を考慮して: compressed行 - 1(マーカー) + omitted行 = original行
    expect(compressedLines - 1 + omittedLines).toBe(originalLines);
  });
});
