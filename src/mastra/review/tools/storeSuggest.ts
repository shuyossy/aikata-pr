import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'node:fs';
import { readStoredSuggestions, type StoredSuggestion } from '../suggestTypes.js';
import type { IndexedCheckItem } from '../indexedCheckItem.js';
import type { SuggestionLineResolver } from '../../../application/shared/port/suggestion/index.js';
import { Suggestion, MAX_ORIGINAL_CODE_LINES } from '../../../domain/review/suggestion/index.js';

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
 * コード変更提案をJSONファイルに保存するMastra Tool
 * suggestResultFilePath, checkItems, activeSuggests, suggestionLineResolver, fullMrDiffはRequestContextから取得する
 * 排他制御付きでファイルへの読み書きを行う
 */
export const storeSuggestTool = createTool({
  id: 'store-suggest',
  description:
    'Store a code suggestion for a check item. The suggestion proposes a concrete code change to fix an issue found during review.',
  inputSchema: z.object({
    checkItemId: z.number().describe('ID of the check item (the number shown in [ID: N])'),
    filePath: z.string().describe('File path where the suggestion applies'),
    originalCode: z
      .string()
      .describe(
        'The exact original code from the new side of the diff to be replaced. Include enough context lines for unique identification.',
      ),
    suggestedCode: z.string().describe('The proposed replacement code'),
    comment: z.string().describe('Explanation of why this change is suggested'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the store operation succeeded'),
    message: z.string().optional().describe('Error or informational message'),
  }),
  execute: async (inputData, context) => {
    const { checkItemId, filePath, originalCode, suggestedCode, comment } = inputData;

    // 1. RequestContextからチェック項目一覧を取得し、checkItemIdが対象範囲内か検証する
    const checkItems = context?.requestContext?.get('checkItems') as IndexedCheckItem[] | undefined;
    const matchedItem = checkItems?.find((item) => item.id === checkItemId);
    if (!matchedItem) {
      const validIds = checkItems?.map((item) => `[ID: ${item.id}]`).join(', ') ?? 'none';
      return {
        success: false,
        message: `checkItemId ${checkItemId} is not in your assigned targets. Valid IDs: ${validIds}`,
      };
    }

    // 2. originalCodeの行数がGitLabの上限を超えていないか検証する
    const originalLines = originalCode.split('\n').length;
    if (originalLines > MAX_ORIGINAL_CODE_LINES) {
      return {
        success: false,
        message: `originalCode is ${originalLines} lines, but GitLab suggestions support a maximum of ${MAX_ORIGINAL_CODE_LINES} lines. Split into smaller suggestions.`,
      };
    }

    // 3. resolverとfullMrDiffが利用可能か検証する
    const resolver = context?.requestContext?.get(
      'suggestionLineResolver',
    ) as SuggestionLineResolver | null;
    const fullMrDiff = context?.requestContext?.get('fullMrDiff') as string | null;

    if (!resolver || !fullMrDiff) {
      return {
        success: false,
        message: 'Suggestion line resolution is not available in this context.',
      };
    }

    // 4. activeSuggestsとの重複チェック（以前のレビューで有効なsuggest）
    const activeSuggests = context?.requestContext?.get('activeSuggests') as Array<{
      filePath: string;
      originalCode: string;
    }> | null;

    // 入力からSuggestionドメインオブジェクトを生成して重複判定に使用
    const currentSuggestion = new Suggestion({
      checkItemContent: matchedItem.content,
      filePath,
      originalCode,
      suggestedCode,
      comment,
    });

    if (activeSuggests?.some((s) => currentSuggestion.isDuplicate(s))) {
      return {
        success: false,
        message:
          'A suggestion with the same filePath and originalCode already exists from a prior review. Use getSuggests to see existing suggestions.',
      };
    }

    const suggestResultFilePath = context?.requestContext?.get('suggestResultFilePath') as string;
    const lockPath = `${suggestResultFilePath}.lock`;

    acquireLock(lockPath);
    try {
      const storedSuggestions = readStoredSuggestions(suggestResultFilePath);

      // 5. 現在のセッションとの重複チェック
      if (storedSuggestions.some((s) => currentSuggestion.isDuplicate(s))) {
        return {
          success: false,
          message:
            'A suggestion with the same filePath and originalCode has already been stored in this session.',
        };
      }

      // 6. 行番号を解決する
      const resolveResult = resolver.resolve(filePath, originalCode, fullMrDiff);
      if (!resolveResult.success) {
        return {
          success: false,
          message: resolveResult.errorMessage,
        };
      }

      // 7. 解決された行番号情報と共に保存する
      const newSuggestion: StoredSuggestion = {
        checkItemId,
        checkItemContent: matchedItem.content,
        filePath,
        originalCode,
        suggestedCode,
        comment,
        newLine: resolveResult.newLine!,
        linesAbove: resolveResult.linesAbove!,
        linesBelow: resolveResult.linesBelow!,
        oldPath: resolveResult.oldPath!,
        newPath: resolveResult.newPath!,
      };

      storedSuggestions.push(newSuggestion);
      fs.writeFileSync(suggestResultFilePath, JSON.stringify(storedSuggestions, null, 2), 'utf-8');

      return { success: true };
    } finally {
      releaseLock(lockPath);
    }
  },
});
