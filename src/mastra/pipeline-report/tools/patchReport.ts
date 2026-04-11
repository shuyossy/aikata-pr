import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

// Atomics.waitによる同期スリープ用バッファ
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * ファイルロックを取得する（mkdir を利用したアトミックロック）
 */
function acquireLock(lockPath: string, timeout: number): void {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch {
      Atomics.wait(sleepBuffer, 0, 0, 50);
    }
  }
  throw new Error('Failed to acquire file lock');
}

/**
 * ファイルロックを解放する
 */
function releaseLock(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * 正規表現で使用する特殊文字をエスケープする
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 分析レポートをピンポイントで書き換えるMastra Tool
 * oldStringをnewStringへ置換する。replaceAll=falseで複数マッチならambiguousを返す。
 */
export const patchReportTool = createTool({
  id: 'patch-report',
  description:
    'Replace a specific substring in the pipeline analysis report. ' +
    'Use this when you want to surgically update a portion of the report without rewriting it. ' +
    'If oldString appears multiple times, set replaceAll=true to replace every occurrence.',
  inputSchema: z.object({
    oldString: z.string().describe('Exact substring to search for in the existing report'),
    newString: z.string().describe('Replacement text'),
    replaceAll: z
      .boolean()
      .describe('When true, replace every occurrence. When false, require a unique match.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    matchCount: z.number(),
    error: z.enum(['ambiguous', 'not-found', 'fs-error']).optional(),
    message: z.string().optional(),
  }),
  execute: async ({ oldString, newString, replaceAll }, context) => {
    const filePath = context?.requestContext?.get('resultFilePath') as string | undefined;
    if (typeof filePath !== 'string' || filePath === '') {
      return {
        success: false,
        matchCount: 0,
        error: 'fs-error' as const,
        message: 'resultFilePath is not configured in RequestContext',
      };
    }

    const lockPath = `${filePath}.lock`;
    const lockTimeoutRaw = context?.requestContext?.get('reportLockTimeoutMs');
    const lockTimeout = typeof lockTimeoutRaw === 'number' ? lockTimeoutRaw : 5000;

    try {
      acquireLock(lockPath, lockTimeout);
    } catch (err) {
      return {
        success: false,
        matchCount: 0,
        error: 'fs-error' as const,
        message: err instanceof Error ? err.message : 'Failed to acquire file lock',
      };
    }

    try {
      let original: string;
      try {
        original = await fsp.readFile(filePath, 'utf8');
      } catch (err) {
        return {
          success: false,
          matchCount: 0,
          error: 'fs-error' as const,
          message: err instanceof Error ? err.message : 'Failed to read report',
        };
      }

      // 出現回数を数える（String#splitでマッチ数をカウント）
      const matchCount = oldString === '' ? 0 : original.split(oldString).length - 1;

      if (matchCount === 0) {
        return {
          success: false,
          matchCount: 0,
          error: 'not-found' as const,
          message: `oldString was not found in the report`,
        };
      }

      if (matchCount > 1 && !replaceAll) {
        return {
          success: false,
          matchCount,
          error: 'ambiguous' as const,
          message: `oldString matches ${matchCount} locations. Set replaceAll=true to replace all.`,
        };
      }

      // 置換の実行。replaceAllの場合は全置換、そうでなければ先頭のみ
      let updated: string;
      if (replaceAll) {
        updated = original.replace(new RegExp(escapeRegExp(oldString), 'g'), () => newString);
      } else {
        updated = original.replace(oldString, newString);
      }

      try {
        await fsp.writeFile(filePath, updated, 'utf8');
      } catch (err) {
        return {
          success: false,
          matchCount,
          error: 'fs-error' as const,
          message: err instanceof Error ? err.message : 'Failed to write report',
        };
      }

      return { success: true, matchCount };
    } finally {
      releaseLock(lockPath);
    }
  },
});
