import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

// Atomics.waitによる同期スリープ用バッファ
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * ファイルロックを取得する（mkdir を利用したアトミックロック）
 * review/tools/storeReviewResult.ts の実装をpipeline-report用に流用
 */
function acquireLock(lockPath: string, timeout = 5000): void {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch {
      // ロックが既に存在する場合は短時間待機してリトライ
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
 * 分析レポートをファイルへ一括書き込みするMastra Tool
 * 既存内容は上書きされる。排他制御付き。
 */
export const writeReportTool = createTool({
  id: 'write-report',
  description:
    'Write the full pipeline analysis report to the report file. This overwrites any existing content. ' +
    'Use this tool when composing the report from scratch or replacing it entirely.',
  inputSchema: z.object({
    content: z.string().describe('Full report content to write'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    charsWritten: z.number(),
    message: z.string().optional(),
  }),
  execute: async ({ content }, context) => {
    const filePath = context?.requestContext?.get('resultFilePath') as string | undefined;
    if (typeof filePath !== 'string' || filePath === '') {
      return {
        success: false,
        charsWritten: 0,
        message: 'resultFilePath is not configured in RequestContext',
      };
    }

    const lockPath = `${filePath}.lock`;
    // テスト等でロックタイムアウトを短縮するための内部フック
    // PipelineAnalysisAgentRequestContext で `reportLockTimeoutMs: number | undefined` として型定義されている
    const lockTimeoutRaw = context?.requestContext?.get('reportLockTimeoutMs') as
      | number
      | undefined;
    const lockTimeout =
      typeof lockTimeoutRaw === 'number' && lockTimeoutRaw > 0 ? lockTimeoutRaw : 5000;
    try {
      acquireLock(lockPath, lockTimeout);
    } catch (err) {
      return {
        success: false,
        charsWritten: 0,
        message: err instanceof Error ? err.message : 'Failed to acquire file lock',
      };
    }

    try {
      await fsp.writeFile(filePath, content, 'utf8');
      return { success: true, charsWritten: content.length };
    } catch (err) {
      return {
        success: false,
        charsWritten: 0,
        message: err instanceof Error ? err.message : 'Failed to write report',
      };
    } finally {
      releaseLock(lockPath);
    }
  },
});
