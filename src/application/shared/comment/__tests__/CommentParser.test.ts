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

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
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

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
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

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
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

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
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

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
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

    it('パイプ文字を含むチェック項目がラウンドトリップで正しくパースされる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('条件A | 条件B の確認'),
          new Rating('A', '完全に満たしている'),
          '問題ありません',
        ),
      ];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].checkItem.content).toBe('条件A | 条件B の確認');
      expect(parsed!.results[0].rating.label).toBe('A');
      expect(parsed!.results[0].comment).toBe('問題ありません');
    });

    it('パイプ文字を含むコメントがラウンドトリップで正しくパースされる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('可読性'),
          new Rating('A', '完全に満たしている'),
          'if (a | b) のパターンに注意',
        ),
      ];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].checkItem.content).toBe('可読性');
      expect(parsed!.results[0].comment).toBe('if (a | b) のパターンに注意');
    });

    it('パイプ文字を含む複数行がラウンドトリップで正しくパースされる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('条件A | 条件B'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
        ReviewResult.success(
          new CheckItem('テストカバレッジ'),
          new Rating('B', '概ね満たしている'),
          'X | Y | Z を確認',
        ),
        ReviewResult.success(
          new CheckItem('通常のチェック項目'),
          new Rating('C', '満たしていない'),
          '通常のコメント',
        ),
      ];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(3);
      expect(parsed!.results[0].checkItem.content).toBe('条件A | 条件B');
      expect(parsed!.results[1].comment).toBe('X | Y | Z を確認');
      expect(parsed!.results[2].checkItem.content).toBe('通常のチェック項目');
      expect(parsed!.results[2].comment).toBe('通常のコメント');
    });

    it('エラー行にパイプ文字を含む場合も正しくパースされる', () => {
      const results = [ReviewResult.error(new CheckItem('A | B のチェック'), 'Error | timeout')];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].checkItem.content).toBe('A | B のチェック');
      expect(parsed!.results[0].isError).toBe(true);
      expect(parsed!.results[0].comment).toBe('Error | timeout');
    });

    it('改行を含むコメントがラウンドトリップで正しくパースされる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('可読性'),
          new Rating('A', '完全に満たしている'),
          '1行目\n2行目\n3行目',
        ),
      ];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].comment).toBe('1行目\n2行目\n3行目');
    });

    it('改行を含むチェック項目がラウンドトリップで正しくパースされる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('項目A\n項目B'),
          new Rating('A', '完全に満たしている'),
          'コメント',
        ),
      ];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].checkItem.content).toBe('項目A\n項目B');
    });

    it('改行とパイプを両方含む場合のラウンドトリップ', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('A | B\nC | D'),
          new Rating('A', '完全に満たしている'),
          '行1\n行2 | 行3',
        ),
      ];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        [],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].checkItem.content).toBe('A | B\nC | D');
      expect(parsed!.results[0].comment).toBe('行1\n行2 | 行3');
    });

    it('hiddenResultsを含むメタデータからhiddenResultsを復元できる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
        ReviewResult.success(
          new CheckItem('チェック項目2'),
          new Rating('B', '概ね満たしている'),
          'コメント2',
        ),
      ];

      // Aを非表示にしてフォーマット
      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        ['A'],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      // テーブルにはB評定のみ
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].rating.label).toBe('B');
      // hiddenResultsにA評定
      expect(parsed!.hiddenResults).toHaveLength(1);
      expect(parsed!.hiddenResults[0].checkItem.content).toBe('チェック項目1');
      expect(parsed!.hiddenResults[0].rating.label).toBe('A');
      expect(parsed!.hiddenResults[0].comment).toBe('コメント1');
    });

    it('hiddenResults付きコメントのラウンドトリップが正しく動作する', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('項目A'),
          new Rating('A', '完全に満たしている'),
          'Aコメント',
        ),
        ReviewResult.success(
          new CheckItem('項目B'),
          new Rating('B', '概ね満たしている'),
          'Bコメント',
        ),
        ReviewResult.success(
          new CheckItem('項目C'),
          new Rating('C', '満たしていない'),
          'Cコメント',
        ),
      ];

      const comment = CommentFormatter.formatComment(
        results,
        ratings,
        commitHash,
        'test commit',
        ['A'],
        { passed: true, violations: [] },
      );
      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      // visible: B, C
      expect(parsed!.results).toHaveLength(2);
      expect(parsed!.results[0].checkItem.content).toBe('項目B');
      expect(parsed!.results[1].checkItem.content).toBe('項目C');
      // hidden: A
      expect(parsed!.hiddenResults).toHaveLength(1);
      expect(parsed!.hiddenResults[0].checkItem.content).toBe('項目A');
    });

    it('旧フォーマットのコメントでもhiddenResultsは空配列で返る', () => {
      // 旧フォーマット（hiddenResultsなし）を手動で構築
      const body = [
        '<!-- aikata-review -->',
        `<!-- aikata-review-data: ${JSON.stringify({ ratings: [{ label: 'A', definition: '完全に満たしている' }], commitHash: 'old123' })} -->`,
        '',
        '| チェック項目 | 評定 | コメント |',
        '| --- | --- | --- |',
        '| 旧チェック項目 | A | 旧コメント |',
      ].join('\n');

      const parsed = CommentParser.parseComment(body);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.hiddenResults).toEqual([]);
    });

    it('エスケープなしの旧コメント（パイプなし）が引き続きパースできる', () => {
      // 旧フォーマットを手動で構築（エスケープなし）
      const body = [
        '<!-- aikata-review -->',
        `<!-- aikata-review-data: ${JSON.stringify({ ratings: [{ label: 'A', definition: '完全に満たしている' }], commitHash: 'old123' })} -->`,
        '',
        '| チェック項目 | 評定 | コメント |',
        '| --- | --- | --- |',
        '| 旧チェック項目 | A | 旧コメント |',
      ].join('\n');

      const parsed = CommentParser.parseComment(body);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0].checkItem.content).toBe('旧チェック項目');
      expect(parsed!.results[0].rating.label).toBe('A');
      expect(parsed!.results[0].comment).toBe('旧コメント');
      expect(parsed!.commitHash).toBe('old123');
    });
  });
});
