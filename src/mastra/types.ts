import { z } from 'zod';
import * as fs from 'node:fs';

/**
 * レビュー結果の保存形式のZodスキーマ
 * storeReviewResultツール、getReviewResultsツール、reviewWorkflowで共通利用する
 */
export const storedReviewResultSchema = z.object({
  checkItemContent: z.string(),
  ratingLabel: z.string(),
  ratingDefinition: z.string(),
  comment: z.string(),
  isError: z.boolean(),
  errorMessage: z.string().optional(),
});

export type StoredReviewResult = z.infer<typeof storedReviewResultSchema>;

/**
 * 結果ファイルからStoredReviewResult配列を読み込む
 * ファイルが存在しない場合は空配列を返す
 */
export function readStoredResults(filePath: string): StoredReviewResult[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as StoredReviewResult[];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
}
