import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { getJobLogDetailTool } from '../getJobLogDetail.js';

type GetJobLogDetailResult = {
  omittedText: string | null;
  reason: string | null;
  message?: string | null;
};

/**
 * getJobLogDetailToolのexecuteを呼び出すヘルパー
 */
const executeGetJobLogDetail = (
  input: { jobId: number; keywords?: string[]; contextLines?: number },
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

    expect(result.omittedText).toBe('middle portion of log for job 42');
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
});
