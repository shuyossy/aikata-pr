import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { filterByKeywords } from '../../shared/keywordFilter.js';

/**
 * RequestContextに格納される「省略されたジョブログ中間部分」のキー名
 */
export const OMITTED_JOB_LOGS_KEY = 'omittedJobLogs';

/**
 * 圧縮済みジョブログの省略された中間部分を取得するMastra Tool
 * 圧縮されていないジョブに対しては omittedText=null と reason を返す
 * キーワード指定時は省略部分内でマッチする行と周辺コンテキストを返す
 */
export const getJobLogDetailTool = createTool({
  id: 'get-job-log-detail',
  description:
    'Retrieve the omitted middle portion of a compressed job log. ' +
    'Use this when the job log in the user prompt contains a "[aikata: N lines omitted]" marker. ' +
    'Returns only the middle portion that was removed during compression for the given jobId. ' +
    'If no keywords are provided, the entire omitted portion is returned. ' +
    'Supports keyword search to efficiently find specific patterns within the omitted portion.',
  inputSchema: z.object({
    jobId: z.number().describe('Target job ID'),
    keywords: z
      .array(z.string())
      .optional()
      .describe(
        'Optional keyword list to filter log lines within the omitted portion. ' +
          'Lines matching ANY keyword are returned with surrounding context. ' +
          'If omitted, the entire omitted portion is returned.',
      ),
    contextLines: z
      .number()
      .optional()
      .describe('Number of context lines around each keyword match (default: 3)'),
  }),
  outputSchema: z.object({
    omittedText: z.string().nullable(),
    reason: z.string().nullable(),
    message: z.string().nullable().optional(),
  }),
  execute: async (
    {
      jobId,
      keywords,
      contextLines,
    }: { jobId: number; keywords?: string[]; contextLines?: number },
    context,
  ) => {
    const omittedJobLogs = context?.requestContext?.get(OMITTED_JOB_LOGS_KEY) as
      | Map<number, string>
      | undefined;

    const omittedText = omittedJobLogs?.get(jobId);
    if (typeof omittedText !== 'string') {
      return {
        omittedText: null,
        reason: 'this job log was not compressed',
      };
    }

    // キーワードフィルタリング
    if (keywords && keywords.length > 0) {
      const { filteredText, hasMatches } = filterByKeywords(omittedText, keywords, contextLines);

      if (!hasMatches) {
        return {
          omittedText: '',
          reason: null,
          message: `No lines matching keywords "${keywords.join(', ')}" found in omitted log for job ${jobId}.`,
        };
      }

      return { omittedText: filteredText, reason: null };
    }

    return { omittedText, reason: null };
  },
});
