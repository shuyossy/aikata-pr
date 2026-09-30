import { describe, it, expect } from 'vitest';
import { CommentParser } from '../CommentParser.js';
import { CommentFormatter, FOLD_THRESHOLD, REVIEW_COMMENT_CLOSE } from '../CommentFormatter.js';
import { ReviewResult } from '../../../../domain/review/reviewResult/index.js';
import { CheckItem } from '../../../../domain/review/checkItem/index.js';
import { Rating } from '../../../../domain/review/rating/index.js';

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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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
      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: ['A'],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

      const comment = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: ['A'],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });
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

  describe('メタデータからの復元と旧フォーマット互換', () => {
    const aiContent = 'カテゴリ:\n---\n設計\n---\n\nチェック項目:\n---\n命名規則\n---';

    /** 旧フォーマット（メタデータに可視結果を含まない）のコメントを組み立てる */
    const buildLegacyComment = (
      rows: { displayContent: string; ratingLabel: string; comment: string }[],
    ): string =>
      [
        '<!-- aikata-review -->',
        `<!-- aikata-review-data: ${JSON.stringify({
          ratings: ratings.map((r) => ({ label: r.label, definition: r.definition })),
          commitHash,
        })} -->`,
        '',
        '## AIKATA-PR レビュー結果',
        'レビュー時最新コミット: test commit',
        '',
        '| チェック項目 | 評定 | コメント |',
        '| --- | --- | --- |',
        ...rows.map((r) => `| ${r.displayContent} | ${r.ratingLabel} | ${r.comment} |`),
      ].join('\n');

    it('メタデータの可視結果から復元する（表の表示内容には依存しない）', () => {
      const results = [
        ReviewResult.success(new CheckItem(aiContent), new Rating('A', '完全に満たしている'), 'OK'),
      ];
      const comment = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        // 表示は表示用contentで行われるが、復元されるのはAI用contentである
        layout: 'sections',
        checkItemDisplayContents: new Map([[aiContent, 'チェック項目:\n---\n命名規則\n---']]),
      });

      const parsed = CommentParser.parseComment(comment);

      expect(parsed).not.toBeNull();
      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0]!.checkItem.content).toBe(aiContent);
      expect(parsed!.results[0]!.rating.label).toBe('A');
      expect(parsed!.results[0]!.comment).toBe('OK');
    });

    it('複数列チェックリストでも往復でAI用contentが保持される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem(aiContent),
          new Rating('B', '概ね満たしている'),
          'まあまあ',
        ),
      ];
      const comment = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      const parsed = CommentParser.parseComment(comment);

      expect(parsed!.results[0]!.checkItem.content).toBe(aiContent);
    });

    it('sectionsレイアウトのコメントもエラー結果を含めて復元できる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          '## 詳細\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
        ),
        ReviewResult.error(new CheckItem('チェック項目2'), 'API呼び出しエラー'),
      ];
      const comment = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'sections',
        checkItemDisplayContents: new Map(),
      });

      const parsed = CommentParser.parseComment(comment);

      expect(parsed!.results).toHaveLength(2);
      expect(parsed!.results[0]!.comment).toBe('## 詳細\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
      expect(parsed!.results[1]!.isError).toBe(true);
      expect(parsed!.results[1]!.comment).toBe('API呼び出しエラー');
    });

    it('メタデータに可視結果を持たない旧フォーマットのコメントは表からパースする', () => {
      const comment = buildLegacyComment([
        { displayContent: 'コードの可読性', ratingLabel: 'A', comment: '良いコードです' },
        { displayContent: 'テストカバレッジ', ratingLabel: 'B', comment: '改善の余地あり' },
      ]);

      const parsed = CommentParser.parseComment(comment);

      expect(parsed!.results).toHaveLength(2);
      expect(parsed!.results[0]!.checkItem.content).toBe('コードの可読性');
      expect(parsed!.results[0]!.rating.label).toBe('A');
      expect(parsed!.results[1]!.checkItem.content).toBe('テストカバレッジ');
      expect(parsed!.results[1]!.comment).toBe('改善の余地あり');
    });

    it('旧フォーマットのエラー行も表からパースできる', () => {
      const comment = buildLegacyComment([
        { displayContent: 'コードの可読性', ratingLabel: 'エラー', comment: 'API呼び出しエラー' },
      ]);

      const parsed = CommentParser.parseComment(comment);

      expect(parsed!.results[0]!.isError).toBe(true);
      expect(parsed!.results[0]!.comment).toBe('API呼び出しエラー');
    });
  });

  describe('コメント本文の復元（メタデータに本文を持たないフォーマット）', () => {
    it('sectionsレイアウトで見出しを含むコメント本文も完全一致で復元できる', () => {
      const comment1 =
        '### 指摘1\n\n- a.ts の命名\n\n### 指摘2\n\n| ファイル | 内容 |\n| --- | --- |\n| b.ts | 型 |';
      const comment2 = '### 良い点\n\n問題ありません';
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          comment1,
        ),
        ReviewResult.success(
          new CheckItem('チェック項目2'),
          new Rating('B', '概ね満たしている'),
          comment2,
        ),
      ];

      const body = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'sections',
        checkItemDisplayContents: new Map(),
      });

      const parsed = CommentParser.parseComment(body);

      expect(parsed!.results[0]!.comment).toBe(comment1);
      expect(parsed!.results[1]!.comment).toBe(comment2);
    });

    it('tableレイアウトでパイプ・改行を含むコメント本文を復元できる', () => {
      const comment = '注意: a|b の扱い\n2行目';
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          comment,
        ),
      ];

      const body = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      const parsed = CommentParser.parseComment(body);

      expect(parsed!.results[0]!.comment).toBe(comment);
    });

    it('非表示結果のコメント本文はメタデータから復元される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          '非表示コメント',
        ),
        ReviewResult.success(
          new CheckItem('チェック項目2'),
          new Rating('B', '概ね満たしている'),
          '表示コメント',
        ),
      ];

      const body = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: ['A'],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'sections',
        checkItemDisplayContents: new Map(),
      });

      const parsed = CommentParser.parseComment(body);

      expect(parsed!.results[0]!.comment).toBe('表示コメント');
      expect(parsed!.hiddenResults[0]!.checkItem.content).toBe('チェック項目1');
      expect(parsed!.hiddenResults[0]!.comment).toBe('非表示コメント');
    });

    it('メタデータにコメント本文を持つフォーマットは表示部分より優先して復元する', () => {
      // PBI2時点のフォーマット（可視結果にcommentを含む）
      const body = [
        '<!-- aikata-review -->',
        `<!-- aikata-review-data: ${JSON.stringify({
          ratings: ratings.map((r) => ({ label: r.label, definition: r.definition })),
          commitHash,
          visibleResults: [
            {
              checkItemContent: 'チェック項目1',
              ratingLabel: 'A',
              comment: 'メタデータのコメント',
            },
          ],
        })} -->`,
        '',
        '## AIKATA-PR レビュー結果',
        'レビュー時最新コミット: test commit',
        '',
        '| チェック項目 | 評定 | コメント |',
        '| --- | --- | --- |',
        '| 表示用チェック項目 | A | 表示用のコメント |',
      ].join('\n');

      const parsed = CommentParser.parseComment(body);

      expect(parsed!.results[0]!.checkItem.content).toBe('チェック項目1');
      expect(parsed!.results[0]!.comment).toBe('メタデータのコメント');
    });

    it('表示部分のコメントが失われている場合も例外を投げず空文字で復元する', () => {
      // 表示部分が手編集などで削除されたコメントを想定
      const body = [
        '<!-- aikata-review -->',
        `<!-- aikata-review-data: ${JSON.stringify({
          ratings: ratings.map((r) => ({ label: r.label, definition: r.definition })),
          commitHash,
          visibleResults: [{ checkItemContent: 'チェック項目1', ratingLabel: 'A' }],
        })} -->`,
        '',
        '## AIKATA-PR レビュー結果',
      ].join('\n');

      const parsed = CommentParser.parseComment(body);

      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0]!.checkItem.content).toBe('チェック項目1');
      expect(parsed!.results[0]!.comment).toBe('');
    });

    it('コメント本文の区切りマーカーが閉じていない場合も例外を投げない', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          '詳細コメント',
        ),
      ];
      const body = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage: 'test commit',
        hiddenRatingLabels: [],
        qualityGateResult: { passed: true, violations: [] },
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'sections',
        checkItemDisplayContents: new Map(),
      });
      // 終了マーカーが失われた（手編集で切り詰められた）コメントを想定
      const truncated = body.slice(0, body.indexOf(REVIEW_COMMENT_CLOSE));

      const parsed = CommentParser.parseComment(truncated);

      expect(parsed!.results).toHaveLength(1);
      expect(parsed!.results[0]!.comment).toBe('');
    });

    it('マーカーはあるがメタデータを持たないコメントはエラーになる', () => {
      const body = ['<!-- aikata-review -->', '', '## AIKATA-PR レビュー結果'].join('\n');

      expect(() => CommentParser.parseComment(body)).toThrow(
        'Review metadata not found in comment body',
      );
    });
  });
});
