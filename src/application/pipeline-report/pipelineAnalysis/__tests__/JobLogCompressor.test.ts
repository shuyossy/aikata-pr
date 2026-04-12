import { describe, it, expect } from 'vitest';
import {
  compressJobLogByPercent,
  compressJobLogByLines,
  compressJobLogsIfNeeded,
} from '../JobLogCompressor.js';
import type { TokenCounter } from '../../../shared/port/tokenCounter/TokenCounter.js';

// テスト用のTokenCounter（1文字=1トークンとして扱う）
const charCounter: TokenCounter = {
  countTokens: (text: string) => text.length,
};

// テスト用のユーザプロンプト組み立て関数
// folderTreeとジョブログを結合した文字列を返す
const userPromptBuilder = (logs: Map<number, string>, folderTree: string): string =>
  `FOLDER:\n${folderTree}\nLOGS:\n${[...logs.entries()]
    .map(([id, t]) => `[${id}]\n${t}`)
    .join('\n')}`;

// 指定行数のジョブログを生成する
const buildJobLog = (prefix: string, lineCount: number): string =>
  Array.from({ length: lineCount }, (_, i) => `${prefix}-${i + 1}`).join('\n');

describe('compressJobLogByPercent', () => {
  it('keepPercentが0の場合は元のテキストをそのまま返す', () => {
    const text = 'line1\nline2\nline3\nline4';
    const result = compressJobLogByPercent(text, 0);
    expect(result.compressed).toBe(text);
    expect(result.omitted).toBe('');
  });

  it('保持行数が全体の半分以上の場合はそのまま返す', () => {
    // 4行×60% = keepLines=2、2*2=4 ≥ 4 → 圧縮しない
    const text = 'a\nb\nc\nd';
    const result = compressJobLogByPercent(text, 60);
    expect(result.compressed).toBe(text);
    expect(result.omitted).toBe('');
  });

  it('中央部分を省略し、上部と下部を保持する', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n');
    const result = compressJobLogByPercent(text, 20); // keepLines = 2
    // 先頭2行と末尾2行が保持される
    expect(result.compressed.startsWith('l1\nl2\n')).toBe(true);
    expect(result.compressed.endsWith('\nl9\nl10')).toBe(true);
    expect(result.compressed).toContain('chars omitted from middle of job log');
    expect(result.compressed).toContain('getJobLogDetail');
    expect(result.omitted).toBe('l3\nl4\nl5\nl6\nl7\nl8');
  });
});

describe('compressJobLogByLines', () => {
  it('keepLines=0の場合は1行目のみ保持する', () => {
    const text = 'header\nbody1\nbody2';
    const result = compressJobLogByLines(text, 0);
    expect(result.compressed.startsWith('header\n')).toBe(true);
    expect(result.compressed).toContain('chars omitted from middle of job log');
    expect(result.omitted).toBe('body1\nbody2');
  });

  it('keepLines=0で1行しかない場合はそのまま返す', () => {
    const text = 'only';
    const result = compressJobLogByLines(text, 0);
    expect(result.compressed).toBe('only');
    expect(result.omitted).toBe('');
  });

  it('保持行数が全体以上の場合はそのまま返す', () => {
    const text = 'a\nb\nc';
    const result = compressJobLogByLines(text, 2);
    expect(result.compressed).toBe(text);
    expect(result.omitted).toBe('');
  });

  it('中央部分を省略する', () => {
    const text = Array.from({ length: 6 }, (_, i) => `x${i + 1}`).join('\n');
    const result = compressJobLogByLines(text, 1);
    expect(result.compressed.startsWith('x1\n')).toBe(true);
    expect(result.compressed.endsWith('\nx6')).toBe(true);
    expect(result.omitted).toBe('x2\nx3\nx4\nx5');
  });
});

describe('compressJobLogsIfNeeded', () => {
  // 全シナリオ共通のオプション
  // maxContextLength=500, thresholdRatio=0.6 → threshold=300 chars
  const options = {
    maxContextLength: 500,
    thresholdRatio: 0.6,
    initialKeepPercent: 50,
    keepPercentStep: 10,
    minKeepPercent: 10,
  };

  it('閾値以下なら圧縮せずそのまま返す', () => {
    const logs = new Map<number, string>([
      [1, 'short log'],
      [2, 'another short log'],
    ]);
    const folderTree = 'src/\n  main.ts';

    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      logs,
      folderTree,
      charCounter,
      options,
    );

    expect(result.compressed).toBe(false);
    expect(result.folderTreeStripped).toBe(false);
    expect(result.strippedFolderTree).toBe(folderTree);
    expect(result.compressedJobLogs).toEqual(logs);
    expect(result.omittedJobLogs.size).toBe(0);
    expect(result.compressedJobIds.size).toBe(0);
  });

  it('folderTreeのファイル行除去のみで閾値以下に収まる場合', () => {
    // folderTreeに大量のファイル行、ログは短い
    // ファイル行を削除すると閾値以下に収まるように調整
    const folderTree = [
      'src/',
      '  main.ts',
      '  a.ts',
      '  b.ts',
      '  c.ts',
      '  d.ts',
      '  e.ts',
      '  f.ts',
      '  g.ts',
      '  h.ts',
      '  i.ts',
      '  j.ts',
      '  ' + 'x'.repeat(250), // ダミーの長いファイル行
    ].join('\n');
    const logs = new Map<number, string>([[1, 'log for job 1']]);

    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      logs,
      folderTree,
      charCounter,
      options,
    );

    expect(result.compressed).toBe(true);
    expect(result.folderTreeStripped).toBe(true);
    expect(result.strippedFolderTree).toBe('src/');
    // ジョブログ自体は圧縮されていない
    expect(result.compressedJobLogs.get(1)).toBe('log for job 1');
    expect(result.omittedJobLogs.size).toBe(0);
    expect(result.compressedJobIds.size).toBe(0);
  });

  it('Phase 1 (keepPercent) のみで閾値以下に収まる場合', () => {
    // 大きな単一ログを用意し、folderTreeは短くする
    const bigLog = buildJobLog('line', 100); // 約790文字
    const folderTree = 'src/';
    const logs = new Map<number, string>([[1, bigLog]]);

    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      logs,
      folderTree,
      charCounter,
      options,
    );

    expect(result.compressed).toBe(true);
    expect(result.compressedJobIds.has(1)).toBe(true);
    expect(result.omittedJobLogs.has(1)).toBe(true);
    const compressedText = result.compressedJobLogs.get(1)!;
    expect(compressedText).toContain('chars omitted from middle of job log');
    // 閾値(300)以下に収まっていることを確認
    const finalPromptLength = userPromptBuilder(
      result.compressedJobLogs,
      result.strippedFolderTree,
    ).length;
    expect(finalPromptLength).toBeLessThanOrEqual(300);
  });

  it('Phase 2 (keepLines半減) まで進まないと収まらない場合', () => {
    // 複数の中程度のログを用意
    // Phase 1では収まらず、Phase 2のkeepLines半減で収まるように調整
    const logs = new Map<number, string>();
    for (let i = 1; i <= 5; i += 1) {
      logs.set(i, buildJobLog(`j${i}`, 40));
    }
    const folderTree = 'src/';

    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      logs,
      folderTree,
      charCounter,
      options,
    );

    expect(result.compressed).toBe(true);
    // 何らかのジョブが圧縮されている
    expect(result.compressedJobIds.size).toBeGreaterThan(0);
    // best-effortで処理が完了している
    for (const [, text] of result.compressedJobLogs) {
      expect(typeof text).toBe('string');
    }
  });

  it('best-effortで閾値まで下げきれなくてもエラーを投げない', () => {
    // 極めて小さい閾値を設定し、どう圧縮しても閾値を下回らないケース
    const tinyOptions = {
      maxContextLength: 50,
      thresholdRatio: 0.2, // threshold = 10 chars
      initialKeepPercent: 50,
      keepPercentStep: 10,
      minKeepPercent: 10,
    };
    const logs = new Map<number, string>([
      [1, buildJobLog('alpha', 30)],
      [2, buildJobLog('beta', 30)],
    ]);
    const folderTree = 'src/\n  main.ts\n  a.ts';

    // エラーを投げずに結果を返すこと
    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      logs,
      folderTree,
      charCounter,
      tinyOptions,
    );

    expect(result.compressed).toBe(true);
    // 何らかの圧縮記録がある
    expect(result.compressedJobIds.size).toBeGreaterThan(0);
  });

  it('省略マーカーの文言にjob log用の指示が含まれる', () => {
    const bigLog = buildJobLog('line', 200);
    const logs = new Map<number, string>([[1, bigLog]]);
    const folderTree = 'src/';

    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      logs,
      folderTree,
      charCounter,
      options,
    );

    const compressedText = result.compressedJobLogs.get(1)!;
    expect(compressedText).toMatch(
      /\[aikata: \d+ chars omitted from middle of job log\. Use getJobLogDetail tool with jobId to view omitted portion\]/,
    );
  });

  it('omittedJobLogsに省略された中央部分が記録される', () => {
    const bigLog = buildJobLog('line', 200);
    const logs = new Map<number, string>([[1, bigLog]]);
    const folderTree = 'src/';

    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      logs,
      folderTree,
      charCounter,
      options,
    );

    const omitted = result.omittedJobLogs.get(1);
    expect(omitted).toBeDefined();
    // 省略部分にはマーカー文言が含まれていない（中央部分の素データのみ）
    expect(omitted).not.toContain('chars omitted from middle of job log');
    // 省略部分の行はすべて元のログの行である
    for (const line of omitted!.split('\n')) {
      expect(bigLog).toContain(line);
    }
  });
});
