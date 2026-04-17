import { describe, it, expect } from 'vitest';
import { SuggestCommentParser } from '../SuggestCommentParser.js';
import {
  SuggestCommentFormatter,
  SUGGEST_MARKER,
  SUGGEST_DATA_PREFIX,
  SUGGEST_DATA_SUFFIX,
} from '../SuggestCommentFormatter.js';
import { ResolvedSuggestion } from '../../../../domain/review/suggestion/index.js';
import { Suggestion } from '../../../../domain/review/suggestion/index.js';

/**
 * テストヘルパー: フォーマット済みのsuggestコメント本文を生成する
 */
const createFormattedBody = (
  overrides: Partial<{
    checkItemContent: string;
    filePath: string;
    suggestedCode: string;
    comment: string;
    linesAbove: number;
    linesBelow: number;
  }> = {},
): string => {
  const suggestion = new Suggestion({
    checkItemContent: overrides.checkItemContent ?? 'テスト項目',
    filePath: overrides.filePath ?? 'src/test.ts',
    originalCode: 'original code',
    suggestedCode: overrides.suggestedCode ?? 'suggested code',
    comment: overrides.comment ?? 'テストコメント',
  });

  const resolved = new ResolvedSuggestion({
    suggestion,
    newLine: 10,
    linesAbove: overrides.linesAbove ?? 0,
    linesBelow: overrides.linesBelow ?? 0,
    oldPath: 'src/test.ts',
    newPath: 'src/test.ts',
  });

  return SuggestCommentFormatter.format(resolved);
};

describe('SuggestCommentParser', () => {
  describe('isSuggestComment', () => {
    it('suggestマーカーを含むコメントに対してtrueを返す', () => {
      const body = createFormattedBody();
      expect(SuggestCommentParser.isSuggestComment(body)).toBe(true);
    });

    it('suggestマーカーを含まないコメントに対してfalseを返す', () => {
      expect(SuggestCommentParser.isSuggestComment('通常のコメント')).toBe(false);
    });

    it('reviewマーカーのみのコメントに対してfalseを返す', () => {
      expect(SuggestCommentParser.isSuggestComment('<!-- aikata-review -->\nsome content')).toBe(
        false,
      );
    });
  });

  describe('parse', () => {
    it('フォーマット済みの本文から正しいメタデータを抽出する', () => {
      const body = createFormattedBody({
        checkItemContent: '抽出テスト',
        filePath: 'src/extract.ts',
        suggestedCode: 'return 42',
      });

      const parsed = SuggestCommentParser.parse(body);

      expect(parsed).not.toBeNull();
      expect(parsed!.checkItemContent).toBe('抽出テスト');
      expect(parsed!.filePath).toBe('src/extract.ts');
      expect(parsed!.originalCode).toBe('original code');
      expect(parsed!.suggestedCode).toBe('return 42');
    });

    it('suggestマーカーを含まない本文に対してnullを返す', () => {
      const result = SuggestCommentParser.parse('普通のコメントです');
      expect(result).toBeNull();
    });

    it('メタデータJSONが不正な場合にnullを返す', () => {
      const body = `${SUGGEST_MARKER}\n${SUGGEST_DATA_PREFIX}{invalid json${SUGGEST_DATA_SUFFIX}\n残りの本文`;
      const result = SuggestCommentParser.parse(body);
      expect(result).toBeNull();
    });

    it('メタデータサフィックスが欠落している場合にnullを返す', () => {
      const body = `${SUGGEST_MARKER}\n${SUGGEST_DATA_PREFIX}{"checkItemContent":"test","filePath":"a.ts","suggestedCode":"x"}\n残りの本文`;
      const result = SuggestCommentParser.parse(body);
      expect(result).toBeNull();
    });
  });
});
