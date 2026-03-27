import { describe, it, expect } from 'vitest';
import {
  CommentFormatter,
  REVIEW_MARKER,
  REVIEW_DATA_PREFIX,
  REVIEW_DATA_SUFFIX,
  FOLD_THRESHOLD,
} from '../CommentFormatter.js';
import { ReviewResult } from '../../../../domain/reviewResult/index.js';
import { CheckItem } from '../../../../domain/checkItem/index.js';
import { Rating } from '../../../../domain/rating/index.js';

describe('CommentFormatter', () => {
  const ratings = [
    new Rating('A', '完全に満たしている'),
    new Rating('B', '概ね満たしている'),
    new Rating('C', '満たしていない'),
  ];
  const commitHash = 'abc1234';

  /**
   * テストヘルパー: 指定件数のレビュー結果を生成する
   */
  const createResults = (count: number): ReviewResult[] => {
    return Array.from({ length: count }, (_, i) => {
      const checkItem = new CheckItem(`チェック項目${i + 1}`);
      const rating = ratings[i % ratings.length];
      return ReviewResult.success(checkItem, rating, `コメント${i + 1}`);
    });
  };

  describe('formatComment', () => {
    it('基本的なMarkdown表を生成できる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('コードの可読性'),
          new Rating('A', '完全に満たしている'),
          '可読性は十分です',
        ),
        ReviewResult.success(
          new CheckItem('テストカバレッジ'),
          new Rating('B', '概ね満たしている'),
          'カバレッジを改善してください',
        ),
      ];

      const output = CommentFormatter.formatComment(results, ratings, commitHash);

      // テーブルヘッダの確認
      expect(output).toContain('| チェック項目 | 評定 | コメント |');
      expect(output).toContain('| --- | --- | --- |');
      // 行の確認
      expect(output).toContain('| コードの可読性 | A | 可読性は十分です |');
      expect(output).toContain('| テストカバレッジ | B | カバレッジを改善してください |');
    });

    it('マーカーが含まれている', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment(results, ratings, commitHash);

      expect(output).toContain(REVIEW_MARKER);
    });

    it('メタデータマーカーに評定基準とコミットハッシュが含まれている', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment(results, ratings, commitHash);

      // メタデータマーカーの存在確認
      expect(output).toContain(REVIEW_DATA_PREFIX);
      expect(output).toContain(REVIEW_DATA_SUFFIX);

      // メタデータのJSON部分を抽出してパース
      const dataStart = output.indexOf(REVIEW_DATA_PREFIX) + REVIEW_DATA_PREFIX.length;
      const dataEnd = output.indexOf(REVIEW_DATA_SUFFIX, dataStart);
      const jsonStr = output.substring(dataStart, dataEnd);
      const metadata = JSON.parse(jsonStr);

      // 評定基準の確認
      expect(metadata.ratings).toEqual([
        { label: 'A', definition: '完全に満たしている' },
        { label: 'B', definition: '概ね満たしている' },
        { label: 'C', definition: '満たしていない' },
      ]);
      // コミットハッシュの確認
      expect(metadata.commitHash).toBe('abc1234');
    });

    it('エラー結果は評定欄に「エラー」が表示される', () => {
      const results = [
        ReviewResult.error(new CheckItem('エラーのチェック項目'), 'Timeout occurred'),
      ];

      const output = CommentFormatter.formatComment(results, ratings, commitHash);

      expect(output).toContain('| エラーのチェック項目 | エラー | Timeout occurred |');
    });

    it('15項目超の場合は折りたたみ形式になる', () => {
      const results = createResults(FOLD_THRESHOLD + 1);

      const output = CommentFormatter.formatComment(results, ratings, commitHash);

      expect(output).toContain('<details>');
      expect(output).toContain('<summary>');
      expect(output).toContain('</summary>');
      expect(output).toContain('</details>');
    });

    it('15項目以下の場合は折りたたみにならない', () => {
      const results = createResults(FOLD_THRESHOLD);

      const output = CommentFormatter.formatComment(results, ratings, commitHash);

      expect(output).not.toContain('<details>');
      expect(output).not.toContain('<summary>');
      expect(output).not.toContain('</details>');
    });
  });
});
