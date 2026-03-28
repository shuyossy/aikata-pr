import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { storedReviewResultSchema, readStoredResults } from '../types.js';
import type { IndexedCheckItem } from '../indexedCheckItem.js';

/**
 * レビュー結果をJSONファイルから取得するMastra Tool
 * RequestContextにcheckItemsが含まれている場合、担当チェック項目の結果のみ返す
 */
export const getReviewResultsTool = createTool({
  id: 'get-review-results',
  description:
    'Retrieve review results from a JSON file. When RequestContext contains checkItems, only results for those items are returned.',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the JSON file storing results'),
  }),
  outputSchema: z.object({
    results: z.array(storedReviewResultSchema),
  }),
  execute: async (inputData, context) => {
    const allResults = readStoredResults(inputData.filePath);

    // RequestContextからcheckItemsを取得してフィルタリング
    const checkItems = context?.requestContext?.get('checkItems') as IndexedCheckItem[] | undefined;
    if (checkItems && checkItems.length > 0) {
      const validIds = checkItems.map((item) => item.id);
      return { results: allResults.filter((r) => validIds.includes(r.checkItemId)) };
    }

    return { results: allResults };
  },
});
