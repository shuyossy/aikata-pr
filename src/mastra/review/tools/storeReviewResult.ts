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
 * resultFilePath, ratingsはRequestContextから取得する
 * 排他制御付きでファイルへの読み書きを行う
 */
export const storeReviewResultTool = createTool({
  id: 'store-review-result',
  description: 'Store a review result for a single check item.',
  inputSchema: z.object({
    checkItemId: z.number().describe('ID of the check item (the number shown in [ID: N])'),
    ratingLabel: z.string().describe('Rating label (e.g., A, B, C)'),
    comment: z.string().describe('Review comment for this check item'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the store operation succeeded'),
    message: z.string().optional().describe('Error or informational message'),
  }),
  execute: async (inputData, context) => {
    const { checkItemId, ratingLabel, comment } = inputData;

    // RequestContextからresultFilePathを取得
    const filePath = context?.requestContext?.get('resultFilePath') as string;

    // RequestContextからratingsを取得し、ratingLabelからdefinitionを導出
    const ratings = context?.requestContext?.get('ratings') as
      | Array<{ label: string; definition: string }>
      | undefined;
    const matchedRating = ratings?.find((r) => r.label === ratingLabel);
    if (!matchedRating) {
      const validLabels = ratings?.map((r) => r.label).join(', ') ?? 'none';
      return {
        success: false,
        message: `Invalid ratingLabel "${ratingLabel}". Valid labels are: ${validLabels}`,
      };
    }

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
        ratingDefinition: matchedRating.definition,
        comment,
        isError: false,
      };

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
