import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { filterByKeywords } from '../../shared/keywordFilter.js';
import { applyOutputLimit } from '../../shared/outputLimiter.js';

/**
 * RequestContextに格納する省略されたdiffデータのキー名
 */
export const OMITTED_FILE_DIFFS_KEY = 'omittedFileDiffs';

/**
 * RequestContextに格納するdiff内の全ファイルパスのキー名
 */
export const ALL_DIFF_FILE_PATHS_KEY = 'allDiffFilePaths';

/**
 * 圧縮されたdiffの省略部分を取得するMastra Tool
 *
 * ファイルパスを指定して、圧縮時に省略された中間部分を返す。
 * キーワード指定時は省略部分内でマッチする行と周辺コンテキストを返���。
 * 出力はトークン制限が適用され、大きなdiffは切り詰められる。
 */
export const getDiffDetailTool = createTool({
  id: 'get-diff-detail',
  description:
    'Retrieve the omitted portion of a compressed file diff. ' +
    'Use when you see "[aikata: N lines omitted]" in the diff. ' +
    'Returns only the middle portion that was removed during compression. ' +
    'Output is token-limited; use startLine/maxLines to paginate through large diffs. ' +
    'Supports keyword search to efficiently find specific code patterns within the omitted portion.',
  inputSchema: z.object({
    filePath: z.string().describe('File path from the diff header (e.g., "src/index.ts")'),
    keywords: z
      .array(z.string())
      .optional()
      .describe(
        'Optional keyword list to filter diff lines within the omitted portion. ' +
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
    success: z.boolean(),
    filePath: z.string(),
    diff: z.string().optional(),
    message: z.string().optional(),
    totalLines: z.number().optional(),
    shownLines: z.number().optional(),
    truncated: z.boolean().optional(),
  }),
  execute: async (
    {
      filePath,
      keywords,
      contextLines,
      startLine,
      maxLines,
    }: {
      filePath: string;
      keywords?: string[];
      contextLines?: number;
      startLine?: number;
      maxLines?: number;
    },
    context,
  ) => {
    // RequestContextからomittedFileDiffsを取得
    const omittedFileDiffs = context?.requestContext?.get(OMITTED_FILE_DIFFS_KEY) as
      | Map<string, string>
      | undefined;

    if (!omittedFileDiffs) {
      return {
        success: false,
        filePath,
        message: 'No compressed diff data available in this session.',
      };
    }

    // ファイルパスで検索（完全一致 → 部分一致フォールバック）
    let diff = omittedFileDiffs.get(filePath);
    if (!diff) {
      for (const [key, value] of omittedFileDiffs) {
        if (key.endsWith(filePath) || filePath.endsWith(key)) {
          diff = value;
          break;
        }
      }
    }

    if (!diff) {
      // allDiffFilePathsを使って「圧縮されていないファイル」と「存���しないファイル」を区別
      const allDiffFilePaths = context?.requestContext?.get(ALL_DIFF_FILE_PATHS_KEY) as
        | Set<string>
        | undefined;

      if (allDiffFilePaths) {
        // 完全一致または部分一致でdiffに存在するか確認
        let existsInDiff = allDiffFilePaths.has(filePath);
        if (!existsInDiff) {
          for (const p of allDiffFilePaths) {
            if (p.endsWith(filePath) || filePath.endsWith(p)) {
              existsInDiff = true;
              break;
            }
          }
        }

        if (existsInDiff) {
          return {
            success: true,
            filePath,
            diff: '',
            message:
              'The complete diff for this file is already provided in the prompt. No omitted portion exists.',
          };
        }
      }

      const availableFiles = Array.from(omittedFileDiffs.keys()).join(', ');
      return {
        success: false,
        filePath,
        message: `File not found in compressed diffs. Available compressed files: ${availableFiles}`,
      };
    }

    // キーワードフィルタリング
    let textToLimit = diff;
    if (keywords && keywords.length > 0) {
      const { filteredText, hasMatches } = filterByKeywords(diff, keywords, contextLines);

      if (!hasMatches) {
        return {
          success: true,
          filePath,
          diff: '',
          message: `No lines matching keywords "${keywords.join(', ')}" found in omitted diff for ${filePath}.`,
          totalLines: diff.split('\n').length,
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
      success: true,
      filePath,
      diff: limitResult.text,
      totalLines,
      shownLines: limitResult.shownLines,
      truncated: limitResult.truncated,
    };
  },
});
