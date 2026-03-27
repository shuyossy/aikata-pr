import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { storedReviewResultSchema, readStoredResults } from '../types.js';

/**
 * レビュー結果をJSONファイルから取得するMastra Tool
 */
export const getReviewResultsTool = createTool({
  id: 'get-review-results',
  description: 'Retrieve all review results from a JSON file',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the JSON file storing results'),
  }),
  outputSchema: z.object({
    results: z.array(storedReviewResultSchema),
  }),
  execute: async (inputData) => {
    const results = readStoredResults(inputData.filePath);
    return { results };
  },
});
