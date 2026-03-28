import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'node:fs';
import { readStoredResults, type StoredReviewResult } from '../types.js';
import type { IndexedCheckItem } from '../indexedCheckItem.js';

// Atomics.waitによる同期スリープ用バッファ
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * ファイルロックを取得する（mkdir を利用したアトミックロック）
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
 * レビュー結果をJSONファイルに保存するMastra Tool
 * 排他制御付きでファイルへの読み書きを行う
 */
export const storeReviewResultTool = createTool({
  id: 'store-review-result',
  description: 'Store a single review result to a JSON file with exclusive file locking',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the JSON file for storing results'),
    checkItemId: z.number().describe('1-based ID of the check item'),
    ratingLabel: z.string().describe('Rating label (e.g., A, B, C)'),
    ratingDefinition: z.string().describe('Definition of the rating label'),
    comment: z.string().describe('Review comment'),
    isError: z.boolean().describe('Whether this result is an error'),
    errorMessage: z.string().optional().describe('Error message if isError is true'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the store operation succeeded'),
    message: z.string().optional().describe('Error or informational message'),
  }),
  execute: async (inputData, context) => {
    const { filePath, checkItemId, ratingLabel, ratingDefinition, comment, isError, errorMessage } =
      inputData;

    // RequestContextからチェック項目一覧を取得し、IDが対象範囲内か検証する
    const checkItems = context?.requestContext?.get('checkItems') as IndexedCheckItem[] | undefined;
    if (checkItems && checkItems.length > 0) {
      const validIds = checkItems.map((item) => item.id);
      if (!validIds.includes(checkItemId)) {
        const targetList = checkItems.map((item) => `[ID: ${item.id}] ${item.content}`).join(', ');
        return {
          success: false,
          message: `checkItemId ${checkItemId} is not in your assigned review targets. Your targets are: ${targetList}`,
        };
      }
    }

    const lockPath = `${filePath}.lock`;

    acquireLock(lockPath);
    try {
      const results: StoredReviewResult[] = readStoredResults(filePath);

      const newResult: StoredReviewResult = {
        checkItemId,
        ratingLabel,
        ratingDefinition,
        comment,
        isError,
      };
      if (errorMessage !== undefined) {
        newResult.errorMessage = errorMessage;
      }

      const existingIndex = results.findIndex((r) => r.checkItemId === checkItemId);
      if (existingIndex >= 0) {
        results[existingIndex] = newResult;
      } else {
        results.push(newResult);
      }

      fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');

      return { success: true };
    } finally {
      releaseLock(lockPath);
    }
  },
});
