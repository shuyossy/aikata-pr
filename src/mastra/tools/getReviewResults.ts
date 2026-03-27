import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'node:fs';

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
    results: z.array(
      z.object({
        checkItemContent: z.string(),
        ratingLabel: z.string(),
        ratingDefinition: z.string(),
        comment: z.string(),
        isError: z.boolean(),
        errorMessage: z.string().optional(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const { filePath } = inputData;

    // ファイルが存在しない場合は空配列を返す
    if (!fs.existsSync(filePath)) {
      return { results: [] };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const results = JSON.parse(content) as Array<{
      checkItemContent: string;
      ratingLabel: string;
      ratingDefinition: string;
      comment: string;
      isError: boolean;
      errorMessage?: string;
    }>;

    return { results };
  },
});
