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
    linesAbove: number;
    linesBelow: number;
  }> = {},
): string => {
  const suggestion = new Suggestion({
    checkItemContent: overrides.checkItemContent ?? 'テスト項目',
    filePath: 'src/test.ts',
    originalCode: 'original code',
    suggestedCode: 'suggested code',
    comment: 'テストコメント',
  });

  const resolved = new ResolvedSuggestion({
    suggestion,
    newLine: 10,
    linesAbove: overrides.linesAbove ?? 0,
    linesBelow: overrides.linesBelow ?? 0,
    oldPath: 'src/test.ts',
    newPath: 'src/test.ts',
  });

  return SuggestCommentFormatter.format(resolved, new Map());
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
    it('フォーマット済みの本文からcheckItemContentを抽出する', () => {
      const body = createFormattedBody({
        checkItemContent: '抽出テスト',
      });

      const parsed = SuggestCommentParser.parse(body);

      expect(parsed).not.toBeNull();
      expect(parsed!.checkItemContent).toBe('抽出テスト');
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
      const body = `${SUGGEST_MARKER}\n${SUGGEST_DATA_PREFIX}{"checkItemContent":"test"}\n残りの本文`;
      const result = SuggestCommentParser.parse(body);
      expect(result).toBeNull();
    });

    it('必須フィールド checkItemContent が欠落している場合にnullを返す', () => {
      const body = `${SUGGEST_MARKER}\n${SUGGEST_DATA_PREFIX}{"filePath":"a.ts"}${SUGGEST_DATA_SUFFIX}\n残り`;
      const result = SuggestCommentParser.parse(body);
      expect(result).toBeNull();
    });

    it('checkItemContentのみのメタデータでもパースできる', () => {
      const body = `${SUGGEST_MARKER}\n${SUGGEST_DATA_PREFIX}{"checkItemContent":"test"}${SUGGEST_DATA_SUFFIX}\n残り`;
      const result = SuggestCommentParser.parse(body);
      expect(result).not.toBeNull();
      expect(result!.checkItemContent).toBe('test');
    });
  });

  describe('parseSuggestionRange', () => {
    it('suggestion構文からlinesAboveとlinesBelowを正しく抽出する', () => {
      const body = createFormattedBody({ linesAbove: 2, linesBelow: 3 });
      const range = SuggestCommentParser.parseSuggestionRange(body);

      expect(range).not.toBeNull();
      expect(range!.linesAbove).toBe(2);
      expect(range!.linesBelow).toBe(3);
    });

    it('linesAbove=0, linesBelow=0の場合も正しく抽出する', () => {
      const body = createFormattedBody({ linesAbove: 0, linesBelow: 0 });
      const range = SuggestCommentParser.parseSuggestionRange(body);

      expect(range).not.toBeNull();
      expect(range!.linesAbove).toBe(0);
      expect(range!.linesBelow).toBe(0);
    });

    it('suggestion構文がない場合はnullを返す', () => {
      const result = SuggestCommentParser.parseSuggestionRange('普通のコメント');
      expect(result).toBeNull();
    });
  });
});
