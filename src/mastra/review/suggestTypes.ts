import { z } from 'zod';
import * as fs from 'node:fs';

/**
 * suggest結果の保存形式のZodスキーマ
 * storeSuggestツール、getSuggestsツール、reviewWorkflowで共通利用する
 */
export const storedSuggestionSchema = z.object({
  checkItemId: z.number(),
  checkItemContent: z.string(),
  filePath: z.string(),
  originalCode: z.string(),
  suggestedCode: z.string(),
  comment: z.string(),
  newLine: z.number(),
  linesAbove: z.number(),
  linesBelow: z.number(),
  oldPath: z.string(),
  newPath: z.string(),
});

export type StoredSuggestion = z.infer<typeof storedSuggestionSchema>;

/**
 * suggest結果ファイルからStoredSuggestion配列を読み込む
 * ファイルが存在しない場合は空配列を返す
 */
export function readStoredSuggestions(filePath: string): StoredSuggestion[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return z.array(storedSuggestionSchema).parse(JSON.parse(content));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
}
