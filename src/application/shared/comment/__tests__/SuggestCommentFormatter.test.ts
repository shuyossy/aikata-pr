import { describe, it, expect } from 'vitest';
import {
  SuggestCommentFormatter,
  SUGGEST_MARKER,
  SUGGEST_DATA_PREFIX,
  SUGGEST_DATA_SUFFIX,
} from '../SuggestCommentFormatter.js';
import { SuggestCommentParser } from '../SuggestCommentParser.js';
import { ResolvedSuggestion } from '../../../../domain/review/suggestion/index.js';
import { Suggestion } from '../../../../domain/review/suggestion/index.js';

/**
 * テストヘルパー: デフォルトのResolvedSuggestionを生成する
 */
const createResolvedSuggestion = (
  overrides: Partial<{
    checkItemContent: string;
    filePath: string;
    originalCode: string;
    suggestedCode: string;
    comment: string;
    newLine: number;
    linesAbove: number;
    linesBelow: number;
    oldPath: string;
    newPath: string;
  }> = {},
): ResolvedSuggestion => {
  const suggestion = new Suggestion({
    checkItemContent: overrides.checkItemContent ?? 'エラーハンドリングの確認',
    filePath: overrides.filePath ?? 'src/utils/handler.ts',
    originalCode: overrides.originalCode ?? 'console.log(error)',
    suggestedCode: overrides.suggestedCode ?? 'logger.error(error)',
    comment: overrides.comment ?? 'console.logではなくloggerを使用してください',
  });

  return new ResolvedSuggestion({
    suggestion,
    newLine: overrides.newLine ?? 10,
    linesAbove: overrides.linesAbove ?? 2,
    linesBelow: overrides.linesBelow ?? 1,
    oldPath: overrides.oldPath ?? 'src/utils/handler.ts',
    newPath: overrides.newPath ?? 'src/utils/handler.ts',
  });
};

describe('SuggestCommentFormatter', () => {
  describe('format', () => {
    it('出力にsuggestマーカーが含まれる', () => {
      const resolved = createResolvedSuggestion();
      const output = SuggestCommentFormatter.format(resolved);
      expect(output).toContain(SUGGEST_MARKER);
    });

    it('出力にメタデータJSONがcheckItemContentのみで含まれる', () => {
      const resolved = createResolvedSuggestion({
        checkItemContent: 'テスト項目',
        filePath: 'src/app.ts',
        originalCode: 'console.log(error)',
        suggestedCode: 'return result',
        comment: 'メタデータ検証用コメント',
      });
      const output = SuggestCommentFormatter.format(resolved);

      // メタデータのプレフィックス・サフィックスが含まれる
      expect(output).toContain(SUGGEST_DATA_PREFIX);
      expect(output).toContain(SUGGEST_DATA_SUFFIX);

      // JSONをパースして検証
      const dataStart = output.indexOf(SUGGEST_DATA_PREFIX) + SUGGEST_DATA_PREFIX.length;
      const dataEnd = output.indexOf(SUGGEST_DATA_SUFFIX, dataStart);
      const jsonStr = output.substring(dataStart, dataEnd);
      const metadata = JSON.parse(jsonStr);

      expect(metadata.checkItemContent).toBe('テスト項目');
      // コード内容はメタデータに含まれない
      expect(metadata).not.toHaveProperty('filePath');
      expect(metadata).not.toHaveProperty('originalCode');
      expect(metadata).not.toHaveProperty('suggestedCode');
      expect(metadata).not.toHaveProperty('comment');
    });

    it('出力にチェック項目ヘッダーが含まれる', () => {
      const resolved = createResolvedSuggestion({ checkItemContent: 'コードレビュー項目' });
      const output = SuggestCommentFormatter.format(resolved);
      expect(output).toContain('**チェック項目:**<br>コードレビュー項目');
    });

    it('出力にコメントテキストが含まれる', () => {
      const resolved = createResolvedSuggestion({ comment: '修正を推奨します' });
      const output = SuggestCommentFormatter.format(resolved);
      expect(output).toContain('修正を推奨します');
    });

    it('正しいsuggestion構文（```suggestion:-X+Y）が含まれる', () => {
      const resolved = createResolvedSuggestion({ linesAbove: 2, linesBelow: 1 });
      const output = SuggestCommentFormatter.format(resolved);
      expect(output).toContain('```suggestion:-2+1');
    });

    it('単一行suggest（linesAbove=0, linesBelow=0）の場合 ```suggestion:-0+0 になる', () => {
      const resolved = createResolvedSuggestion({ linesAbove: 0, linesBelow: 0 });
      const output = SuggestCommentFormatter.format(resolved);
      expect(output).toContain('```suggestion:-0+0');
    });

    it('複数行suggest（linesAbove=5, linesBelow=3）の場合 ```suggestion:-5+3 になる', () => {
      const resolved = createResolvedSuggestion({ linesAbove: 5, linesBelow: 3 });
      const output = SuggestCommentFormatter.format(resolved);
      expect(output).toContain('```suggestion:-5+3');
    });

    it('複数列チェック項目が<header>形式で表示され、<br>で改行される', () => {
      const resolved = createResolvedSuggestion({
        checkItemContent:
          'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---',
      });
      const output = SuggestCommentFormatter.format(resolved);
      expect(output).toContain(
        '**チェック項目:**<br><カテゴリ><br>セキュリティ<br>---<br><チェック項目><br>SQLインジェクション対策<br>---',
      );
    });

    it('ラウンドトリップ: formatしてからparseするとcheckItemContentが復元される', () => {
      const resolved = createResolvedSuggestion({
        checkItemContent: 'ラウンドトリップテスト',
        filePath: 'src/roundtrip.ts',
        originalCode: 'const x = 0;',
        suggestedCode: 'const x = 1;',
        comment: 'ラウンドトリップ用コメント',
      });
      const output = SuggestCommentFormatter.format(resolved);
      const parsed = SuggestCommentParser.parse(output);

      expect(parsed).not.toBeNull();
      expect(parsed!.checkItemContent).toBe('ラウンドトリップテスト');
    });

    it('ラウンドトリップ: formatしてからparseSuggestionRangeするとlinesAbove/linesBelowが復元される', () => {
      const resolved = createResolvedSuggestion({
        linesAbove: 3,
        linesBelow: 2,
      });
      const output = SuggestCommentFormatter.format(resolved);
      const range = SuggestCommentParser.parseSuggestionRange(output);

      expect(range).not.toBeNull();
      expect(range!.linesAbove).toBe(3);
      expect(range!.linesBelow).toBe(2);
    });
  });
});
