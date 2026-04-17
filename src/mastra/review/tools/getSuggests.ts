import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readStoredSuggestions } from '../suggestTypes.js';
import type { IndexedCheckItem } from '../indexedCheckItem.js';

/**
 * 全てのsuggest（以前のレビュー + 現在のセッション）を
 * 割り当てられたチェック項目でフィルタリングして返すMastra Tool
 *
 * checkItems, activeSuggests, suggestResultFilePathはRequestContextから取得する
 */
export const getSuggestsTool = createTool({
  id: 'get-suggests',
  description:
    'Retrieve all stored suggestions (from prior reviews and current session) for your assigned check items.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    suggestions: z.array(
      z.object({
        checkItemId: z.number(),
        checkItemContent: z.string(),
        filePath: z.string(),
        originalCode: z.string(),
        suggestedCode: z.string(),
        comment: z.string(),
        source: z.enum(['prior', 'current']),
      }),
    ),
  }),
  execute: async (_inputData, context) => {
    // 割り当てられたチェック項目を取得
    const checkItems = context?.requestContext?.get('checkItems') as IndexedCheckItem[] | undefined;
    if (!checkItems || checkItems.length === 0) {
      return { suggestions: [] };
    }
    const targetContents = new Set(checkItems.map((item) => item.content));

    // 以前のレビューで有効なsuggestを取得
    const activeSuggests = context?.requestContext?.get('activeSuggests') as
      | Array<{
          checkItemContent: string;
          filePath: string;
          originalCode: string;
          suggestedCode: string;
          comment: string;
        }>
      | undefined;

    const priorSuggestions = (activeSuggests ?? [])
      .filter((s) => targetContents.has(s.checkItemContent))
      .map((s) => {
        const matchedItem = checkItems.find((item) => item.content === s.checkItemContent);
        return {
          checkItemId: matchedItem?.id ?? 0,
          checkItemContent: s.checkItemContent,
          filePath: s.filePath,
          originalCode: s.originalCode,
          suggestedCode: s.suggestedCode,
          comment: s.comment,
          source: 'prior' as const,
        };
      });

    // 現在のセッションのsuggestをファイルから取得
    const suggestResultFilePath = context?.requestContext?.get('suggestResultFilePath') as
      | string
      | undefined;
    if (!suggestResultFilePath) {
      return { suggestions: priorSuggestions };
    }

    const storedSuggestions = readStoredSuggestions(suggestResultFilePath);
    const currentSuggestions = storedSuggestions
      .filter((s) => targetContents.has(s.checkItemContent))
      .map((s) => ({
        checkItemId: s.checkItemId,
        checkItemContent: s.checkItemContent,
        filePath: s.filePath,
        originalCode: s.originalCode,
        suggestedCode: s.suggestedCode,
        comment: s.comment,
        source: 'current' as const,
      }));

    return { suggestions: [...priorSuggestions, ...currentSuggestions] };
  },
});
