import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'node:fs';
import type { StoredReviewResult } from '../types.js';

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
    checkItemContent: z.string().describe('Content of the check item'),
    ratingLabel: z.string().describe('Rating label (e.g., A, B, C)'),
    ratingDefinition: z.string().describe('Definition of the rating label'),
    comment: z.string().describe('Review comment'),
    isError: z.boolean().describe('Whether this result is an error'),
    errorMessage: z.string().optional().describe('Error message if isError is true'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the store operation succeeded'),
  }),
  execute: async (inputData) => {
    const {
      filePath,
      checkItemContent,
      ratingLabel,
      ratingDefinition,
      comment,
      isError,
      errorMessage,
    } = inputData;
    const lockPath = `${filePath}.lock`;

    acquireLock(lockPath);
    try {
      // 既存の結果を読み込む
      let results: StoredReviewResult[] = [];
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        results = JSON.parse(content) as StoredReviewResult[];
      }

      // 新しいレビュー結果を作成
      const newResult: StoredReviewResult = {
        checkItemContent,
        ratingLabel,
        ratingDefinition,
        comment,
        isError,
      };
      if (errorMessage !== undefined) {
        newResult.errorMessage = errorMessage;
      }

      // 同じチェック項目が既に存在する場合は上書き、なければ追加
      const existingIndex = results.findIndex((r) => r.checkItemContent === checkItemContent);
      if (existingIndex >= 0) {
        results[existingIndex] = newResult;
      } else {
        results.push(newResult);
      }

      // ファイルに書き込む
      fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');

      return { success: true };
    } finally {
      releaseLock(lockPath);
    }
  },
});
