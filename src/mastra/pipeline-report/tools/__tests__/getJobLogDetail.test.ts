import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { getJobLogDetailTool } from '../getJobLogDetail.js';

type GetJobLogDetailResult = {
  omittedText: string | null;
  reason: string | null;
};

/**
 * getJobLogDetailToolのexecuteを呼び出すヘルパー
 */
const executeGetJobLogDetail = (
  input: { jobId: number },
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
});
