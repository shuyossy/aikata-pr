import { describe, it, expect } from 'vitest';
import { CommentParser } from '../CommentParser.js';
import { CommentFormatter, FOLD_THRESHOLD } from '../CommentFormatter.js';
import { ReviewResult } from '../../../../domain/reviewResult/index.js';
import { CheckItem } from '../../../../domain/checkItem/index.js';
import { Rating } from '../../../../domain/rating/index.js';

describe('CommentParser', () => {
  const ratings = [
    new Rating('A', '完全に満たしている'),
    new Rating('B', '概ね満たしている'),
    new Rating('C', '満たしていない'),
  ];
  const commitHash = 'abc1234';

  describe('parseComment', () => {
    it('マーカー付きコメントからレビュー結果をパースできる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('コードの可読性'),
          new Rating('A', '完全に満たしている'),
          '良いコメントです',
        ),
        ReviewResult.success(
          new CheckItem('テストカバレッジ'),
          new Rating('B', '概ね満たしている'),
          'カバレッジを改善してください',
        ),
      ];

      const comment = CommentFormatter.formatComment(results, ratings, commitHash);
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(2);

      // 1行目の確認
      expect(parsed!.results[0].checkItem.content).toBe('コードの可読性');
      expect(parsed!.results[0].rating.label).toBe('A');
      expect(parsed!.results[0].comment).toBe('良いコメントです');
      expect(parsed!.results[0].isError).toBe(false);

      // 2行目の確認
      expect(parsed!.results[1].checkItem.content).toBe('テストカバレッジ');
      expect(parsed!.results[1].rating.label).toBe('B');
      expect(parsed!.results[1].comment).toBe('カバレッジを改善してください');
      expect(parsed!.results[1].isError).toBe(false);
    });

    it('マーカーのないコメントはnullを返す', () => {
      const body = '通常のMRコメントです。レビューマーカーはありません。';
      const parsed = CommentParser.parseComment(body);

      expect(parsed).toBeNull();
    });

    it('メタデータからRating定義を復元できる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const comment = CommentFormatter.formatComment(results, ratings, commitHash);
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.ratings).toHaveLength(3);
      expect(parsed!.ratings[0].label).toBe('A');
      expect(parsed!.ratings[0].definition).toBe('完全に満たしている');
      expect(parsed!.ratings[1].label).toBe('B');
      expect(parsed!.ratings[1].definition).toBe('概ね満たしている');
      expect(parsed!.ratings[2].label).toBe('C');
      expect(parsed!.ratings[2].definition).toBe('満たしていない');
    });

    it('メタデータからコミットハッシュを復元できる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const comment = CommentFormatter.formatComment(results, ratings, commitHash);
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.commitHash).toBe('abc1234');
    });

    it('折りたたみ形式のコメントもパースできる', () => {
      // FOLD_THRESHOLD + 1件のレビュー結果を作成（折りたたみが発生する）
      const count = FOLD_THRESHOLD + 1;
      const results = Array.from({ length: count }, (_, i) => {
        const checkItem = new CheckItem(`チェック項目${i + 1}`);
        const rating = ratings[i % ratings.length];
        return ReviewResult.success(checkItem, rating, `コメント${i + 1}`);
      });

      const comment = CommentFormatter.formatComment(results, ratings, commitHash);
      // 折りたたみ形式であることを確認
      expect(comment).toContain('<details>');

      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(count);
      expect(parsed!.results[0].checkItem.content).toBe('チェック項目1');
      expect(parsed!.results[count - 1].checkItem.content).toBe(`チェック項目${count}`);
      expect(parsed!.commitHash).toBe('abc1234');
    });

    it('エラー行を正しくパースできる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('コードの可読性'),
          new Rating('A', '完全に満たしている'),
          '良いコメントです',
        ),
        ReviewResult.error(new CheckItem('テストカバレッジ'), 'Timeout occurred'),
      ];

      const comment = CommentFormatter.formatComment(results, ratings, commitHash);
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(2);

      // 正常行
      expect(parsed!.results[0].checkItem.content).toBe('コードの可読性');
      expect(parsed!.results[0].isError).toBe(false);
      expect(parsed!.results[0].rating.label).toBe('A');

      // エラー行
      expect(parsed!.results[1].checkItem.content).toBe('テストカバレッジ');
      expect(parsed!.results[1].isError).toBe(true);
      expect(parsed!.results[1].comment).toBe('Timeout occurred');
    });
  });
});
