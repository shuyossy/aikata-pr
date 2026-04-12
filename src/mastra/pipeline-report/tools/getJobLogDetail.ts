import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * RequestContextに格納される「省略されたジョブログ中間部分」のキー名
 */
export const OMITTED_JOB_LOGS_KEY = 'omittedJobLogs';

/**
 * 圧縮済みジョブログの省略された中間部分を取得するMastra Tool
 * 圧縮されていないジョブに対しては omittedText=null と reason を返す
 */
export const getJobLogDetailTool = createTool({
  id: 'get-job-log-detail',
  description:
    'Retrieve the omitted middle portion of a compressed job log. ' +
    'Use this when the job log in the user prompt contains a "[aikata: N lines omitted]" marker. ' +
    'Returns only the middle portion that was removed during compression for the given jobId.',
  inputSchema: z.object({
    jobId: z.number().describe('Target job ID'),
  }),
  outputSchema: z.object({
    omittedText: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  execute: async ({ jobId }, context) => {
    const omittedJobLogs = context?.requestContext?.get(OMITTED_JOB_LOGS_KEY) as
      | Map<number, string>
      | undefined;

    const omittedText = omittedJobLogs?.get(jobId);
    if (typeof omittedText === 'string') {
      return { omittedText, reason: null };
    }

    return {
      omittedText: null,
      reason: 'this job log was not compressed',
    };
  },
});
