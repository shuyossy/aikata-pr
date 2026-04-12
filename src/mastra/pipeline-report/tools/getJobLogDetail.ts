import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { filterByKeywords } from '../../shared/keywordFilter.js';
import { applyOutputLimit } from '../../shared/outputLimiter.js';

/**
 * RequestContextに格納される「省略されたジョブログ中間部分」のキー名
 */
export const OMITTED_JOB_LOGS_KEY = 'omittedJobLogs';

/**
 * 圧縮済みジョブログの省略された中間部分を取得するMastra Tool
 * 圧縮されていないジョブに対しては omittedText=null と reason を返す
 * キーワード指定時は省略部分内でマッチする行と周辺コンテキストを返す
 * 出力はトークン制限が適用され、大きなログは切り詰められる
 */
export const getJobLogDetailTool = createTool({
  id: 'get-job-log-detail',
  description:
    'Retrieve the omitted middle portion of a compressed job log. ' +
    'Use this when the job log in the user prompt contains a "[aikata: N lines omitted]" marker. ' +
    'Returns only the middle portion that was removed during compression for the given jobId. ' +
    'Output is token-limited; use startLine/maxLines to paginate through large logs. ' +
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
    startLine: z
      .number()
      .optional()
      .describe(
        'Start line number (1-based) within the omitted portion. Use to paginate through large omitted sections. Default: 1',
      ),
    maxLines: z
      .number()
      .optional()
      .describe(
        'Maximum number of lines to return. Applied before token limiting. Useful for retrieving a specific range.',
      ),
  }),
  outputSchema: z.object({
    omittedText: z.string().nullable(),
    reason: z.string().nullable(),
    message: z.string().nullable().optional(),
    totalLines: z.number().optional(),
    shownLines: z.number().optional(),
    truncated: z.boolean().optional(),
  }),
  execute: async (
    {
      jobId,
      keywords,
      contextLines,
      startLine,
      maxLines,
    }: {
      jobId: number;
      keywords?: string[];
      contextLines?: number;
      startLine?: number;
      maxLines?: number;
    },
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
    let textToLimit = omittedText;
    if (keywords && keywords.length > 0) {
      const { filteredText, hasMatches } = filterByKeywords(omittedText, keywords, contextLines);

      if (!hasMatches) {
        return {
          omittedText: '',
          reason: null,
          message: `No lines matching keywords "${keywords.join(', ')}" found in omitted log for job ${jobId}.`,
          totalLines: omittedText.split('\n').length,
          shownLines: 0,
          truncated: false,
        };
      }

      textToLimit = filteredText;
    }

    // startLine/maxLinesによる行スライス
    // totalLinesはstartLine/maxLinesのページネーション対象の行数
    // （キーワードフィルタ後のテキスト行数。フィルタなしの場合は元の省略部分の行数）
    const originalLines = textToLimit.split('\n');
    const totalLines = originalLines.length;

    if (startLine !== undefined || maxLines !== undefined) {
      const start = Math.max((startLine ?? 1) - 1, 0); // 1始まり → 0始まり
      const end = maxLines !== undefined ? start + maxLines : originalLines.length;
      textToLimit = originalLines.slice(start, end).join('\n');
    }

    // 出力制限の適用（行番号付与 + トークン切り詰め）
    const limitResult = applyOutputLimit(textToLimit);

    return {
      omittedText: limitResult.text,
      reason: null,
      totalLines,
      shownLines: limitResult.shownLines,
      truncated: limitResult.truncated,
    };
  },
});
