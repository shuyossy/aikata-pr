import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * RequestContextに格納する省略されたdiffデータのキー名
 */
export const OMITTED_FILE_DIFFS_KEY = 'omittedFileDiffs';

/**
 * RequestContextに格納するdiff内の全ファイルパスのキー名
 */
export const ALL_DIFF_FILE_PATHS_KEY = 'allDiffFilePaths';

/**
 * デフォルトのコンテキスト行数（キーワード検索時）
 */
const DEFAULT_CONTEXT_LINES = 3;

/**
 * 圧縮されたdiffの省略部分を取得するMastra Tool
 *
 * ファイルパスを指定して、圧縮時に省略された中間部分を返す。
 * キーワード指定時は省略部分内でマッチする行と周辺コンテキストを返す。
 */
export const getDiffDetailTool = createTool({
  id: 'get-diff-detail',
  description:
    'Retrieve the omitted portion of a compressed file diff. ' +
    'Use when you see "[aikata: N lines omitted]" in the diff. ' +
    'Returns only the middle portion that was removed during compression. ' +
    'If no keywords are provided, the entire omitted portion is returned. ' +
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
  }),
  outputSchema: z.object({
    success: z.boolean(),
    filePath: z.string(),
    diff: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async (
    {
      filePath,
      keywords,
      contextLines,
    }: { filePath: string; keywords?: string[]; contextLines?: number },
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
      // allDiffFilePathsを使って「圧縮されていないファイル」と「存在しないファイル」を区別
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
    if (keywords && keywords.length > 0) {
      const lines = diff.split('\n');
      const ctx = contextLines ?? DEFAULT_CONTEXT_LINES;
      const matchingIndices = new Set<number>();

      lines.forEach((line, i) => {
        const lowerLine = line.toLowerCase();
        if (keywords.some((kw) => lowerLine.includes(kw.toLowerCase()))) {
          for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
            matchingIndices.add(j);
          }
        }
      });

      if (matchingIndices.size === 0) {
        return {
          success: true,
          filePath,
          diff: '',
          message: `No lines matching keywords "${keywords.join(', ')}" found in omitted diff for ${filePath}.`,
        };
      }

      const sortedIndices = Array.from(matchingIndices).sort((a, b) => a - b);
      const filteredLines: string[] = [];
      let lastIndex = -2;
      for (const idx of sortedIndices) {
        if (idx > lastIndex + 1) {
          filteredLines.push('...');
        }
        filteredLines.push(lines[idx]!);
        lastIndex = idx;
      }

      return {
        success: true,
        filePath,
        diff: filteredLines.join('\n'),
      };
    }

    // キーワードなし: 省略された中間部分をそのまま返す
    return {
      success: true,
      filePath,
      diff,
    };
  },
});
