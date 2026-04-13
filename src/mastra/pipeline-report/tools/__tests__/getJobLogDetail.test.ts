import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { getJobLogDetailTool } from '../getJobLogDetail.js';

type GetJobLogDetailResult = {
  omittedText: string | null;
  reason: string | null;
  message?: string | null;
  totalLines?: number;
  shownLines?: number;
  truncated?: boolean;
};

/**
 * getJobLogDetailToolのexecuteを呼び出すヘルパー
 */
const executeGetJobLogDetail = (
  input: {
    jobId: number;
    keywords?: string[];
    contextLines?: number;
    startLine?: number;
    maxLines?: number;
  },
  omittedJobLogs: Map<number, string>,
): Promise<GetJobLogDetailResult> => {
  const executeFn = getJobLogDetailTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([['omittedJobLogs', omittedJobLogs]]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof getJobLogDetailTool.execute>>[1];
  return executeFn(input, context) as Promise<GetJobLogDetailResult>;
};

describe('getJobLogDetailTool', () => {
  it('圧縮されたジョブの省略部分を取得できる', async () => {
    const omittedLogs = new Map<number, string>([[42, 'middle portion of log for job 42']]);

    const result = await executeGetJobLogDetail({ jobId: 42 }, omittedLogs);

    // 行番号が付与される
    expect(result.omittedText).toContain('middle portion of log for job 42');
    expect(result.reason).toBeNull();
  });

  it('圧縮されていないジョブではomittedText=nullとreasonを返す', async () => {
    const omittedLogs = new Map<number, string>([[42, 'middle portion']]);

    const result = await executeGetJobLogDetail({ jobId: 99 }, omittedLogs);

    expect(result.omittedText).toBeNull();
    expect(result.reason).toBe('this job log was not compressed');
  });

  it('マップが空でも安全に動作する', async () => {
    const omittedLogs = new Map<number, string>();

    const result = await executeGetJobLogDetail({ jobId: 1 }, omittedLogs);

    expect(result.omittedText).toBeNull();
    expect(result.reason).toBe('this job log was not compressed');
  });

  // --- キーワードフィルタリングのテスト ---

  const sampleLog = [
    'Step 1: Installing dependencies',
    'npm install --production',
    'added 120 packages',
    'Step 2: Running tests',
    'FAIL src/auth.test.ts',
    'Expected: 200',
    'Received: 401',
    'Step 3: Building application',
    'webpack compiled successfully',
  ].join('\n');

  const sampleOmittedLogs = new Map<number, string>([[42, sampleLog]]);

  it('単一キーワードで省略部分内を検索できる', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['FAIL'] },
      sampleOmittedLogs,
    );

    expect(result.omittedText).toContain('FAIL src/auth.test.ts');
    expect(result.reason).toBeNull();
  });

  it('複数キーワードでOR検索できる', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['FAIL', 'webpack'] },
      sampleOmittedLogs,
    );

    expect(result.omittedText).toContain('FAIL src/auth.test.ts');
    expect(result.omittedText).toContain('webpack compiled successfully');
    expect(result.reason).toBeNull();
  });

  it('キーワードにマッチしない場合はomittedText=""とmessageを返す', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['nonexistent_keyword'] },
      sampleOmittedLogs,
    );

    expect(result.omittedText).toBe('');
    expect(result.reason).toBeNull();
    expect(result.message).toContain('nonexistent_keyword');
  });

  it('contextLinesを指定できる', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['FAIL'], contextLines: 1 },
      sampleOmittedLogs,
    );

    // FAIL src/auth.test.ts (index 4) の前後1行
    expect(result.omittedText).toContain('Step 2: Running tests');
    expect(result.omittedText).toContain('FAIL src/auth.test.ts');
    expect(result.omittedText).toContain('Expected: 200');
    // contextLines=1なので、index 0-2の行は含まれない
    expect(result.omittedText).not.toContain('Step 1: Installing dependencies');
  });

  it('contextLines未指定時はデフォルト3行', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['FAIL'] },
      sampleOmittedLogs,
    );

    // FAIL src/auth.test.ts (index 4) の前後3行
    expect(result.omittedText).toContain('npm install --production');
    expect(result.omittedText).toContain('FAIL src/auth.test.ts');
    expect(result.omittedText).toContain('Received: 401');
  });

  it('キーワード検索は大文字小文字を無視する', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['fail'] },
      sampleOmittedLogs,
    );

    expect(result.omittedText).toContain('FAIL src/auth.test.ts');
    expect(result.reason).toBeNull();
  });

  it('非連続のマッチ範囲間に省略マーカーが挿入される', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['Installing', 'webpack'], contextLines: 0 },
      sampleOmittedLogs,
    );

    expect(result.omittedText).toContain('Step 1: Installing dependencies');
    expect(result.omittedText).toContain('...');
    expect(result.omittedText).toContain('webpack compiled successfully');
  });

  it('圧縮されていないジョブにキーワードを指定した場合はomittedText=nullとreasonを返す', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 99, keywords: ['error'] },
      sampleOmittedLogs,
    );

    expect(result.omittedText).toBeNull();
    expect(result.reason).toBe('this job log was not compressed');
  });

  // --- 出力制限・ページネーション関連のテスト ---

  it('出力に行番号が付与される', async () => {
    const omittedLogs = new Map<number, string>([[42, 'line one\nline two\nline three']]);
    const result = await executeGetJobLogDetail({ jobId: 42 }, omittedLogs);

    expect(result.omittedText).toMatch(/^\s*1\u2192/m);
    expect(result.totalLines).toBe(3);
    expect(result.shownLines).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('小さい出力ではtruncated=falseで全行が表示される', async () => {
    const result = await executeGetJobLogDetail({ jobId: 42 }, sampleOmittedLogs);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(9); // sampleLogは9行
    expect(result.shownLines).toBe(9);
  });

  it('大きな省略ログが切り詰められtruncated=trueになる', async () => {
    const largeLines = Array.from(
      { length: 5000 },
      (_, i) => `[2024-01-01] Log entry ${i}: processing data`,
    );
    const largeLogs = new Map<number, string>([[100, largeLines.join('\n')]]);

    const result = await executeGetJobLogDetail({ jobId: 100 }, largeLogs);
    expect(result.truncated).toBe(true);
    expect(result.shownLines!).toBeLessThan(result.totalLines!);
    expect(result.totalLines).toBe(5000);
    expect(result.omittedText).toContain('[output truncated:');
  });

  it('startLineで先頭行をスキップできる', async () => {
    const result = await executeGetJobLogDetail({ jobId: 42, startLine: 5 }, sampleOmittedLogs);

    expect(result.reason).toBeNull();
    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(5); // 5行目〜9行目
    // 1行目の内容が含まれない
    expect(result.omittedText).not.toContain('Step 1: Installing dependencies');
  });

  it('maxLinesで出力行数を制限できる', async () => {
    const result = await executeGetJobLogDetail({ jobId: 42, maxLines: 3 }, sampleOmittedLogs);

    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(3);
  });

  it('startLine + maxLinesでページネーションできる', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, startLine: 3, maxLines: 2 },
      sampleOmittedLogs,
    );

    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(2); // 3行目と4行目のみ
  });

  it('キーワードフィルタ結果にも出力制限が適用される', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['Step'] },
      sampleOmittedLogs,
    );

    expect(result.totalLines).toBeDefined();
    expect(result.shownLines).toBeDefined();
    expect(result.truncated).toBeDefined();
  });

  it('圧縮されていないジョブには出力制限フィールドが含まれない', async () => {
    const result = await executeGetJobLogDetail({ jobId: 99 }, sampleOmittedLogs);
    expect(result.omittedText).toBeNull();
    expect(result.totalLines).toBeUndefined();
    expect(result.truncated).toBeUndefined();
  });

  it('startLineが総行数を超える場合は空のomittedTextを返す', async () => {
    const result = await executeGetJobLogDetail({ jobId: 42, startLine: 100 }, sampleOmittedLogs);
    expect(result.reason).toBeNull();
    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(0);
  });

  it('startLine=0の場合は1行目から開始される', async () => {
    const result = await executeGetJobLogDetail({ jobId: 42, startLine: 0 }, sampleOmittedLogs);
    expect(result.reason).toBeNull();
    expect(result.totalLines).toBe(9);
    expect(result.shownLines).toBe(9);
    expect(result.omittedText).toContain('Step 1: Installing dependencies');
  });

  it('キーワードフィルタとstartLine/maxLinesを組み合わせてページネーションできる', async () => {
    const result = await executeGetJobLogDetail(
      { jobId: 42, keywords: ['Step'], startLine: 2, maxLines: 1 },
      sampleOmittedLogs,
    );
    expect(result.reason).toBeNull();
    // キーワードフィルタ後のテキスト内で2行目から1行分を取得
    expect(result.shownLines).toBe(1);
  });
});
