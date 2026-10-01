import { describe, it, expect } from 'vitest';
import {
  CommentFormatter,
  REVIEW_MARKER,
  REVIEW_DATA_PREFIX,
  REVIEW_DATA_SUFFIX,
  REVIEW_COMMENT_OPEN,
  REVIEW_COMMENT_CLOSE,
  FOLD_THRESHOLD,
} from '../CommentFormatter.js';
import { ReviewResult } from '../../../../domain/review/reviewResult/index.js';
import { CheckItem } from '../../../../domain/review/checkItem/index.js';
import { Rating } from '../../../../domain/review/rating/index.js';
import type { QualityGateResult } from '../../../../domain/review/qualityGate/index.js';

/** 品質ゲート通過時のデフォルト結果 */
const PASSED_GATE: QualityGateResult = { passed: true, violations: [] };

describe('CommentFormatter', () => {
  const ratings = [
    new Rating('A', '完全に満たしている'),
    new Rating('B', '概ね満たしている'),
    new Rating('C', '満たしていない'),
  ];
  const commitHash = 'abc1234';
  const commitMessage = 'feat: add new feature';

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

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      // テーブルヘッダの確認
      expect(output).toContain('| チェック項目 | 評定 | コメント |');
      expect(output).toContain('| --- | --- | --- |');
      // 行の確認
      expect(output).toContain('| コードの可読性 | A | 可読性は十分です |');
      expect(output).toContain('| テストカバレッジ | B | カバレッジを改善してください |');
    });

    it('mrCommentTitle引数がMarkdownのH2ヘッダーとして出力される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('## AIKATA-PR レビュー結果');
    });

    it('mrCommentTitleに任意文字列を渡すとそれがH2ヘッダーに反映される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'API基盤チェック',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('## API基盤チェック');
      expect(output).not.toContain('## AIKATA-PR レビュー結果');
    });

    it('ヘッダーの下にコミットメッセージが表示される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: 'feat: implement login',
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('レビュー時最新コミット: feat: implement login');
    });

    it('マーカーが含まれている', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

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

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

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

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| エラーのチェック項目 | エラー | Timeout occurred |');
    });

    it('15項目超の場合は折りたたみ形式になる', () => {
      const results = createResults(FOLD_THRESHOLD + 1);

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('<details>');
      expect(output).toContain('<summary>');
      expect(output).toContain('</summary>');
      expect(output).toContain('</details>');
    });

    it('15項目以下の場合は折りたたみにならない', () => {
      const results = createResults(FOLD_THRESHOLD);

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).not.toContain('<details>');
      expect(output).not.toContain('<summary>');
      expect(output).not.toContain('</details>');
    });

    it('チェック項目にパイプ文字を含む場合、エスケープされた表が生成される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('条件A | 条件B の確認'),
          new Rating('A', '完全に満たしている'),
          '問題ありません',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| 条件A \\| 条件B の確認 | A | 問題ありません |');
    });

    it('コメントにパイプ文字を含む場合、エスケープされた表が生成される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('可読性'),
          new Rating('A', '完全に満たしている'),
          'if (a | b) のパターンに注意',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| 可読性 | A | if (a \\| b) のパターンに注意 |');
    });

    it('チェック項目とコメントの両方にパイプ文字を含む場合', () => {
      const results = [
        ReviewResult.success(new CheckItem('A|B'), new Rating('A', '完全に満たしている'), 'X|Y|Z'),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| A\\|B | A | X\\|Y\\|Z |');
    });

    it('コメントに改行を含む場合、<br>にエスケープされる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('可読性'),
          new Rating('A', '完全に満たしている'),
          '1行目\n2行目\n3行目',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| 可読性 | A | 1行目<br>2行目<br>3行目 |');
      // 改行がそのまま残っていないことを確認（テーブル行内）
      const tableLines = output.split('\n').filter((l) => l.startsWith('| 可読性'));
      expect(tableLines).toHaveLength(1);
    });

    it('チェック項目に改行を含む場合、<br>にエスケープされる', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('項目A\n項目B'),
          new Rating('A', '完全に満たしている'),
          'コメント',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| 項目A<br>項目B | A | コメント |');
    });

    it('複数列チェック項目が<header>形式で表示される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem(
            'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---',
          ),
          new Rating('C', '満たしていない'),
          '対策が不十分です',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain(
        '| &lt;カテゴリ&gt;<br>セキュリティ<br>---<br>&lt;チェック項目&gt;<br>SQLインジェクション対策<br>--- | C | 対策が不十分です |',
      );
    });
  });

  describe('hiddenRatingLabels', () => {
    it('hiddenRatingLabels未指定では全結果が表に表示される', () => {
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

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| チェック項目1 | A | コメント1 |');
      expect(output).toContain('| チェック項目2 | B | コメント2 |');
    });

    it('hiddenRatingLabelsに一致する評定の結果が表に表示されない', () => {
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

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: ['A'],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).not.toContain('| チェック項目1 | A | コメント1 |');
      expect(output).toContain('| チェック項目2 | B | コメント2 |');
    });

    it('非表示の結果がメタデータのhiddenResultsに格納される', () => {
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

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: ['A'],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      // メタデータのJSON部分を抽出してパース
      const dataStart = output.indexOf(REVIEW_DATA_PREFIX) + REVIEW_DATA_PREFIX.length;
      const dataEnd = output.indexOf(REVIEW_DATA_SUFFIX, dataStart);
      const jsonStr = output.substring(dataStart, dataEnd);
      const metadata = JSON.parse(jsonStr);

      expect(metadata.hiddenResults).toEqual([
        { checkItemContent: 'チェック項目1', ratingLabel: 'A', comment: 'コメント1' },
      ]);
    });

    it('エラー結果はhiddenRatingLabelsに関係なく常に表に表示される', () => {
      const results = [
        ReviewResult.error(new CheckItem('エラー項目'), 'タイムアウト'),
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: ['A'],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| エラー項目 | エラー | タイムアウト |');
      expect(output).not.toContain('| チェック項目1 | A | コメント1 |');
    });

    it('全ての非エラー結果が非表示の場合、代替メッセージが表示される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: ['A'],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).not.toContain('| チェック項目 | 評定 | コメント |');
      expect(output).toContain('全てのチェック項目が非表示の評定に該当しました。');
    });

    it('hiddenRatingLabelsが空配列の場合、メタデータにhiddenResultsが含まれない', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      const dataStart = output.indexOf(REVIEW_DATA_PREFIX) + REVIEW_DATA_PREFIX.length;
      const dataEnd = output.indexOf(REVIEW_DATA_SUFFIX, dataStart);
      const jsonStr = output.substring(dataStart, dataEnd);
      const metadata = JSON.parse(jsonStr);

      expect(metadata.hiddenResults).toBeUndefined();
    });

    it('折りたたみ判定はvisibleResultsの件数で行われる', () => {
      // FOLD_THRESHOLD + 1件のうち、1件を非表示にしてFOLD_THRESHOLD件にする
      const count = FOLD_THRESHOLD + 1;
      const results = Array.from({ length: count }, (_, i) => {
        const checkItem = new CheckItem(`チェック項目${i + 1}`);
        const rating = ratings[i % ratings.length];
        return ReviewResult.success(checkItem, rating, `コメント${i + 1}`);
      });

      // Aを非表示にすると、visible件数が減って折りたたみ閾値以下になる
      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: ['A'],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      // A評定の結果が非表示になるため、visible件数はFOLD_THRESHOLD以下
      expect(output).not.toContain('<details>');
    });
  });

  describe('qualityGateResult', () => {
    it('品質ゲート通過時は警告メッセージが表示されない', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).not.toContain('Quality Gate Failed');
    });

    it('品質ゲート失敗時に警告メッセージが表示される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('C', '満たしていない'),
          'コメント1',
        ),
      ];

      const gateResult: QualityGateResult = {
        passed: false,
        violations: [{ ratingLabel: 'C', threshold: 1, actualCount: 1 }],
      };

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: gateResult,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('> **⚠ Quality Gate Failed**');
      expect(output).toContain('> - Rating "C" : 1 (threshold: 1)');
    });

    it('品質ゲート失敗時に複数のviolationが表示される', () => {
      const results = createResults(4);

      const gateResult: QualityGateResult = {
        passed: false,
        violations: [
          { ratingLabel: 'C', threshold: 1, actualCount: 2 },
          { ratingLabel: 'B', threshold: 1, actualCount: 1 },
        ],
      };

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: gateResult,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('> - Rating "C" : 2 (threshold: 1)');
      expect(output).toContain('> - Rating "B" : 1 (threshold: 1)');
    });

    it('折りたたみ時に警告メッセージがdetailsの前に表示される', () => {
      const results = createResults(FOLD_THRESHOLD + 1);

      const gateResult: QualityGateResult = {
        passed: false,
        violations: [{ ratingLabel: 'C', threshold: 1, actualCount: 1 }],
      };

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: gateResult,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      // 警告がdetails開始タグの前に表示される
      const warningStart = output.indexOf('> **⚠ Quality Gate Failed**');
      const detailsStart = output.indexOf('<details>');
      expect(warningStart).toBeLessThan(detailsStart);
    });

    it('全ての結果が非表示でも品質ゲート警告は表示される', () => {
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          'コメント1',
        ),
      ];

      const gateResult: QualityGateResult = {
        passed: false,
        violations: [{ ratingLabel: 'A', threshold: 1, actualCount: 1 }],
      };

      const output = CommentFormatter.formatComment({
        results: results,
        ratings: ratings,
        commitHash: commitHash,
        commitMessage: commitMessage,
        hiddenRatingLabels: ['A'],
        qualityGateResult: gateResult,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('全てのチェック項目が非表示の評定に該当しました。');
      expect(output).toContain('> **⚠ Quality Gate Failed**');
    });
  });

  describe('メタデータへのレビュー結果格納', () => {
    /** コメント本文からメタデータJSONを取り出す */
    const extractMetadata = (output: string): Record<string, unknown> => {
      const line = output
        .split('\n')
        .find((l) => l.startsWith(REVIEW_DATA_PREFIX) && l.endsWith(REVIEW_DATA_SUFFIX));
      if (!line) throw new Error('metadata not found');
      return JSON.parse(
        line.slice(REVIEW_DATA_PREFIX.length, line.length - REVIEW_DATA_SUFFIX.length),
      ) as Record<string, unknown>;
    };

    it('可視結果が常にメタデータに格納される', () => {
      const output = CommentFormatter.formatComment({
        results: createResults(2),
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(extractMetadata(output).visibleResults).toEqual([
        { checkItemContent: 'チェック項目1', ratingLabel: 'A' },
        { checkItemContent: 'チェック項目2', ratingLabel: 'B' },
      ]);
    });

    it('可視結果のコメント本文はメタデータに格納されない（表示部分と二重化しない）', () => {
      const comment = 'このコメント本文は表示部分にのみ存在するべきである';
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          comment,
        ),
      ];

      const output = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      // コメント本文はコメント全体で1度しか出現しない
      expect(output.split(comment)).toHaveLength(2);
      const metadataLine = output
        .split('\n')
        .find((l) => l.startsWith(REVIEW_DATA_PREFIX)) as string;
      expect(metadataLine).not.toContain(comment);
    });

    it('メタデータのcheckItemContentは表示用ではなくAI用の生contentが格納される', () => {
      const aiContent = 'カテゴリ:\n---\n設計\n---\n\nチェック項目:\n---\n命名規則\n---';
      const results = [
        ReviewResult.success(new CheckItem(aiContent), new Rating('A', '完全に満たしている'), 'OK'),
      ];

      const output = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map([[aiContent, 'チェック項目:\n---\n命名規則\n---']]),
      });

      const visibleResults = extractMetadata(output).visibleResults as {
        checkItemContent: string;
      }[];
      expect(visibleResults[0]!.checkItemContent).toBe(aiContent);
    });

    it('エラー結果はエラー評定ラベルでメタデータに格納される', () => {
      const results = [ReviewResult.error(new CheckItem('チェック項目1'), 'API呼び出しエラー')];

      const output = CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(extractMetadata(output).visibleResults).toEqual([
        { checkItemContent: 'チェック項目1', ratingLabel: 'エラー' },
      ]);
    });

    it('全結果が非表示の場合でも可視結果は空配列として格納される', () => {
      const output = CommentFormatter.formatComment({
        results: createResults(1),
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels: ['A'],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      const metadata = extractMetadata(output);
      expect(metadata.visibleResults).toEqual([]);
      expect(metadata.hiddenResults).toHaveLength(1);
    });
  });

  describe('checkItemDisplayContents', () => {
    const aiContent = 'カテゴリ:\n---\n設計\n---\n\nチェック項目:\n---\n命名規則\n---';
    const displayContent = 'チェック項目:\n---\n命名規則\n---';

    const format = (
      layout: 'table' | 'sections',
      displayContents: ReadonlyMap<string, string>,
    ): string =>
      CommentFormatter.formatComment({
        results: [
          ReviewResult.success(
            new CheckItem(aiContent),
            new Rating('A', '完全に満たしている'),
            'OK',
          ),
        ],
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout,
        checkItemDisplayContents: displayContents,
      });

    it('表示用contentが登録されている場合はテーブルの表示に使われる', () => {
      const output = format('table', new Map([[aiContent, displayContent]]));

      expect(output).toContain('| &lt;チェック項目&gt;<br>命名規則<br>--- | A | OK |');
      expect(output).not.toContain('&lt;カテゴリ&gt;');
    });

    it('表示用contentが未登録の場合はAI用contentがそのまま表示される', () => {
      const output = format('table', new Map());

      expect(output).toContain(
        '&lt;カテゴリ&gt;<br>設計<br>---<br>&lt;チェック項目&gt;<br>命名規則<br>---',
      );
    });

    it('sectionsレイアウトの詳細にも表示用contentが使われる', () => {
      const output = format('sections', new Map([[aiContent, displayContent]]));

      expect(output).toContain('&lt;チェック項目&gt;<br>\n命名規則');
      expect(output).not.toContain('&lt;カテゴリ&gt;');
    });
  });

  describe('tableレイアウト', () => {
    it('#列は追加されず従来の3列テーブルのまま出力される', () => {
      const output = CommentFormatter.formatComment({
        results: createResults(2),
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels: [],
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'table',
        checkItemDisplayContents: new Map(),
      });

      expect(output).toContain('| チェック項目 | 評定 | コメント |');
      expect(output).toContain('| チェック項目1 | A | コメント1 |');
      expect(output).not.toContain('| # |');
    });
  });

  describe('sectionsレイアウト', () => {
    const formatSections = (results: ReviewResult[], hiddenRatingLabels: string[] = []): string =>
      CommentFormatter.formatComment({
        results,
        ratings,
        commitHash,
        commitMessage,
        hiddenRatingLabels,
        qualityGateResult: PASSED_GATE,
        mrCommentTitle: 'AIKATA-PR レビュー結果',
        layout: 'sections',
        checkItemDisplayContents: new Map(),
      });

    it('#・チェック項目・評定のサマリテーブルを生成する', () => {
      const output = formatSections(createResults(2));

      expect(output).toContain('| # | チェック項目 | 評定 |');
      expect(output).toContain('| --- | --- | --- |');
      expect(output).toContain('| 1 | チェック項目1 | A |');
      expect(output).toContain('| 2 | チェック項目2 | B |');
      // tableレイアウトのヘッダは出力されない
      expect(output).not.toContain('| チェック項目 | 評定 | コメント |');
    });

    it('サマリテーブルの下にチェック項目ごとの折りたたみを#番号付きで展開する', () => {
      const output = formatSections(createResults(2));

      expect(output).toContain(
        [
          '<details>',
          '<summary>#1</summary>',
          '',
          'チェック項目1',
          '',
          '**評定: A**',
          '',
          REVIEW_COMMENT_OPEN,
          'コメント1',
          REVIEW_COMMENT_CLOSE,
          '',
          '</details>',
        ].join('\n'),
      );
      expect(output).toContain('<summary>#2</summary>');
      expect(output).toContain('**評定: B**');
      // サマリテーブルより後に詳細が出力される
      expect(output.indexOf('<summary>#1</summary>')).toBeGreaterThan(
        output.indexOf('| 1 | チェック項目1 | A |'),
      );
    });

    it('件数が折りたたみ閾値以下でも項目ごとに折りたたむ', () => {
      const output = formatSections(createResults(1));

      expect(output).toContain('<summary>#1</summary>');
      expect(output).not.toContain('<summary>レビュー結果');
    });

    it('件数が折りたたみ閾値を超えても全体はまとめて折りたたまずサマリテーブルを常に表示する', () => {
      const count = FOLD_THRESHOLD + 1;
      const output = formatSections(createResults(count));

      expect(output.match(/<details>/g)).toHaveLength(count);
      expect(output.match(/<\/details>/g)).toHaveLength(count);
      // サマリテーブルは折りたたみの外側にある
      expect(output.indexOf('| # | チェック項目 | 評定 |')).toBeLessThan(
        output.indexOf('<details>'),
      );
    });

    it('複数列のチェック項目は列名と値を改行を保って表示する', () => {
      const aiContent = 'カテゴリ:\n---\n設計\n---\n\n説明:\n---\n観点A\n観点B\n---';
      const results = [
        ReviewResult.success(new CheckItem(aiContent), new Rating('A', '完全に満たしている'), 'OK'),
      ];

      const output = formatSections(results);

      expect(output).toContain(
        '<summary>#1</summary>\n\n&lt;カテゴリ&gt;<br>\n設計<br>\n&lt;説明&gt;<br>\n観点A<br>\n観点B\n\n**評定: A**',
      );
    });

    it('コメント本文はエスケープされず生Markdownとして出力される', () => {
      const comment = '## 指摘事項\n\n| ファイル | 内容 |\n| --- | --- |\n| a.ts | 命名 |';
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          comment,
        ),
      ];

      const output = formatSections(results);

      expect(output).toContain(comment);
      // テーブルセル向けのエスケープが行われていないこと
      expect(output).not.toContain('\\|');
      expect(output).not.toContain('| ファイル | 内容 |<br>');
    });

    it('コメント本文が区切りマーカーで囲まれる', () => {
      const comment = '## 指摘事項\n\n- a.ts の命名';
      const results = [
        ReviewResult.success(
          new CheckItem('チェック項目1'),
          new Rating('A', '完全に満たしている'),
          comment,
        ),
      ];

      const output = formatSections(results);

      expect(output).toContain(`${REVIEW_COMMENT_OPEN}\n${comment}\n${REVIEW_COMMENT_CLOSE}`);
    });

    it('エラー結果は評定にエラーラベルとエラーメッセージが表示される', () => {
      const results = [ReviewResult.error(new CheckItem('チェック項目1'), 'API呼び出しエラー')];

      const output = formatSections(results);

      expect(output).toContain('| 1 | チェック項目1 | エラー |');
      expect(output).toContain('**評定: エラー**');
      expect(output).toContain('API呼び出しエラー');
    });

    it('非表示評定の結果はサマリにも詳細にも出力されず#番号は表示対象のみで振られる', () => {
      const output = formatSections(createResults(2), ['A']);

      // 非表示結果はメタデータにのみ格納され、表示部分には現れない
      expect(output).not.toContain('| チェック項目1 |');
      expect(output).not.toContain('\nチェック項目1\n');
      expect(output).toContain('| 1 | チェック項目2 | B |');
      expect(output).toContain('<summary>#1</summary>');
      expect(output).not.toContain('<summary>#2</summary>');
    });

    it('全ての結果が非表示の場合はレイアウトによらず専用メッセージを出力する', () => {
      const output = formatSections(createResults(1), ['A']);

      expect(output).toContain('全てのチェック項目が非表示の評定に該当しました。');
      expect(output).not.toContain('| # | チェック項目 | 評定 |');
    });
  });
});
