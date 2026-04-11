import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { storedReviewResultSchema, readStoredResults } from '../types.js';
import type { IndexedCheckItem } from '../indexedCheckItem.js';

/**
 * レビュー結果をJSONファイルから取得するMastra Tool
 * resultFilePathはRequestContextから取得する
 * RequestContextにcheckItemsが含まれている場合、担当チェック項目の結果のみ返す
 */
export const getReviewResultsTool = createTool({
  id: 'get-review-results',
  description: 'Retrieve your stored review results. No arguments needed.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    results: z.array(storedReviewResultSchema),
  }),
  execute: async (_inputData, context) => {
    const filePath = context?.requestContext?.get('resultFilePath') as string;
    const allResults = readStoredResults(filePath);

    // RequestContextからcheckItemsを取得してフィルタリング
    const checkItems = context?.requestContext?.get('checkItems') as IndexedCheckItem[] | undefined;
    if (checkItems && checkItems.length > 0) {
      const validIds = checkItems.map((item) => item.id);
      return { results: allResults.filter((r) => validIds.includes(r.checkItemId)) };
    }

    return { results: allResults };
  },
});
