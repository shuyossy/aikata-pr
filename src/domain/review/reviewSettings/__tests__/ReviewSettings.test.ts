import { describe, it, expect } from 'vitest';
import { ReviewSettings, DEFAULT_MR_COMMENT_TITLE } from '../ReviewSettings.js';
import { Rating } from '../../rating/index.js';
import { QualityGate } from '../../qualityGate/index.js';

describe('ReviewSettings', () => {
  it('全てのフィールドを指定して生成できる', () => {
    const ratings = [new Rating('A', '完全に満たしている'), new Rating('B', '概ね満たしている')];
    const qualityGate = new QualityGate([{ ratingLabel: 'B', threshold: 2 }]);
    const settings = new ReviewSettings({
      additionalInstructions: '追加指示',
      concurrentReviewCount: 3,
      commentFormat: '{comment}',
      ratings,
      hiddenRatingLabels: ['A'],
      suggestEnabledRatingLabels: ['B'],
      qualityGate,
      mrCommentTitle: 'API基盤チェック',
      reviewCommentLayout: 'table',
    });
    expect(settings.additionalInstructions).toBe('追加指示');
    expect(settings.concurrentReviewCount).toBe(3);
    expect(settings.commentFormat).toBe('{comment}');
    expect(settings.ratings).toEqual(ratings);
    expect(settings.hiddenRatingLabels).toEqual(['A']);
    expect(settings.suggestEnabledRatingLabels).toEqual(['B']);
    expect(settings.qualityGate).toBe(qualityGate);
    expect(settings.mrCommentTitle).toBe('API基盤チェック');
  });

  it('concurrentReviewCountがnullの場合は正常に生成できる', () => {
    const settings = new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [new Rating('A', 'def')],
      hiddenRatingLabels: [],
      suggestEnabledRatingLabels: [],
      qualityGate: QualityGate.none(),
      mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
      reviewCommentLayout: 'table',
    });
    expect(settings.concurrentReviewCount).toBeNull();
  });

  it('デフォルト値で生成できる', () => {
    const settings = ReviewSettings.default();
    expect(settings.additionalInstructions).toBe('');
    expect(settings.concurrentReviewCount).toBeNull();
    expect(settings.commentFormat).toContain('【評価理由・根拠】');
    expect(settings.commentFormat).toContain('【改善提案】');
    expect(settings.ratings.length).toBe(4);
    expect(settings.ratings[3].label).toBe('-');
    expect(settings.hiddenRatingLabels).toEqual([]);
    expect(settings.qualityGate.failureCriteria).toEqual([]);
    expect(settings.mrCommentTitle).toBe('AIKATA-PR レビュー結果');
  });

  it('concurrentReviewCountが0以下の場合はエラーになる', () => {
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: 0,
          commentFormat: '{comment}',
          ratings: [new Rating('A', 'def')],
          hiddenRatingLabels: [],
          suggestEnabledRatingLabels: [],
          qualityGate: QualityGate.none(),
          mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
          reviewCommentLayout: 'table',
        }),
    ).toThrow();
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: -1,
          commentFormat: '{comment}',
          ratings: [new Rating('A', 'def')],
          hiddenRatingLabels: [],
          suggestEnabledRatingLabels: [],
          qualityGate: QualityGate.none(),
          mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
          reviewCommentLayout: 'table',
        }),
    ).toThrow();
  });

  it('ratingsが空の場合はエラーになる', () => {
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: 1,
          commentFormat: '{comment}',
          ratings: [],
          hiddenRatingLabels: [],
          suggestEnabledRatingLabels: [],
          qualityGate: QualityGate.none(),
          mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
          reviewCommentLayout: 'table',
        }),
    ).toThrow();
  });

  it('hiddenRatingLabelsが空配列で生成できる', () => {
    const settings = new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [new Rating('A', 'def'), new Rating('B', 'def2')],
      hiddenRatingLabels: [],
      suggestEnabledRatingLabels: [],
      qualityGate: QualityGate.none(),
      mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
      reviewCommentLayout: 'table',
    });
    expect(settings.hiddenRatingLabels).toEqual([]);
  });

  it('hiddenRatingLabelsにratingsに存在するラベルを指定して生成できる', () => {
    const settings = new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [new Rating('A', 'def'), new Rating('B', 'def2'), new Rating('C', 'def3')],
      hiddenRatingLabels: ['A', 'B'],
      suggestEnabledRatingLabels: [],
      qualityGate: QualityGate.none(),
      mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
      reviewCommentLayout: 'table',
    });
    expect(settings.hiddenRatingLabels).toEqual(['A', 'B']);
  });

  it('hiddenRatingLabelsにratingsに存在しないラベルがある場合エラーになる', () => {
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: null,
          commentFormat: '{comment}',
          ratings: [new Rating('A', 'def'), new Rating('B', 'def2')],
          hiddenRatingLabels: ['X'],
          suggestEnabledRatingLabels: [],
          qualityGate: QualityGate.none(),
          mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
          reviewCommentLayout: 'table',
        }),
    ).toThrow();
  });

  it('qualityGateのfailureCriteriaにratingsに存在するラベルを指定して生成できる', () => {
    const qualityGate = new QualityGate([{ ratingLabel: 'C', threshold: 1 }]);
    const settings = new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [new Rating('A', 'def'), new Rating('B', 'def2'), new Rating('C', 'def3')],
      hiddenRatingLabels: [],
      suggestEnabledRatingLabels: [],
      qualityGate,
      mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
      reviewCommentLayout: 'table',
    });
    expect(settings.qualityGate.failureCriteria).toHaveLength(1);
  });

  it('qualityGateのfailureCriteriaにratingsに存在しないラベルがある場合エラーになる', () => {
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: null,
          commentFormat: '{comment}',
          ratings: [new Rating('A', 'def'), new Rating('B', 'def2')],
          hiddenRatingLabels: [],
          suggestEnabledRatingLabels: [],
          qualityGate: new QualityGate([{ ratingLabel: 'X', threshold: 1 }]),
          mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
          reviewCommentLayout: 'table',
        }),
    ).toThrow();
  });

  describe('suggestEnabledRatingLabels', () => {
    it('デフォルト値は["C"]である', () => {
      const settings = ReviewSettings.default();
      expect(settings.suggestEnabledRatingLabels).toEqual(['C']);
    });

    it('ratingsに存在するラベルを指定して生成できる', () => {
      const settings = new ReviewSettings({
        additionalInstructions: '',
        concurrentReviewCount: null,
        commentFormat: '{comment}',
        ratings: [new Rating('A', 'def'), new Rating('B', 'def2'), new Rating('C', 'def3')],
        hiddenRatingLabels: [],
        suggestEnabledRatingLabels: ['B', 'C'],
        qualityGate: QualityGate.none(),
        mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
        reviewCommentLayout: 'table',
      });
      expect(settings.suggestEnabledRatingLabels).toEqual(['B', 'C']);
    });

    it('空配列の場合は正常に生成できる（suggest無効）', () => {
      const settings = new ReviewSettings({
        additionalInstructions: '',
        concurrentReviewCount: null,
        commentFormat: '{comment}',
        ratings: [new Rating('A', 'def'), new Rating('B', 'def2')],
        hiddenRatingLabels: [],
        suggestEnabledRatingLabels: [],
        qualityGate: QualityGate.none(),
        mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
        reviewCommentLayout: 'table',
      });
      expect(settings.suggestEnabledRatingLabels).toEqual([]);
    });

    it('ratingsに存在しないラベルがある場合エラーになる', () => {
      expect(
        () =>
          new ReviewSettings({
            additionalInstructions: '',
            concurrentReviewCount: null,
            commentFormat: '{comment}',
            ratings: [new Rating('A', 'def'), new Rating('B', 'def2')],
            hiddenRatingLabels: [],
            suggestEnabledRatingLabels: ['X'],
            qualityGate: QualityGate.none(),
            mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
            reviewCommentLayout: 'table',
          }),
      ).toThrow('suggestEnabledRatingLabels contains unknown label: X');
    });
  });

  describe('isSuggestEnabled', () => {
    it('suggestEnabledRatingLabelsが空でない場合はtrueを返す', () => {
      const settings = ReviewSettings.default();
      expect(settings.isSuggestEnabled()).toBe(true);
    });

    it('suggestEnabledRatingLabelsが空の場合はfalseを返す', () => {
      const settings = new ReviewSettings({
        additionalInstructions: '',
        concurrentReviewCount: null,
        commentFormat: '{comment}',
        ratings: [new Rating('A', 'def')],
        hiddenRatingLabels: [],
        suggestEnabledRatingLabels: [],
        qualityGate: QualityGate.none(),
        mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
        reviewCommentLayout: 'table',
      });
      expect(settings.isSuggestEnabled()).toBe(false);
    });
  });

  describe("予約フォールバックラベル '-' の許容", () => {
    it("ratingsに '-' を含めなくても hiddenRatingLabels: ['-'] を指定できる", () => {
      const settings = new ReviewSettings({
        additionalInstructions: '',
        concurrentReviewCount: null,
        commentFormat: '{comment}',
        ratings: [new Rating('A', 'def'), new Rating('C', 'def3')],
        hiddenRatingLabels: ['-'],
        suggestEnabledRatingLabels: [],
        qualityGate: QualityGate.none(),
        mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
        reviewCommentLayout: 'table',
      });
      expect(settings.hiddenRatingLabels).toEqual(['-']);
    });

    it("ratingsに '-' を含めなくても suggestEnabledRatingLabels: ['-'] を指定できる", () => {
      const settings = new ReviewSettings({
        additionalInstructions: '',
        concurrentReviewCount: null,
        commentFormat: '{comment}',
        ratings: [new Rating('A', 'def'), new Rating('C', 'def3')],
        hiddenRatingLabels: [],
        suggestEnabledRatingLabels: ['-'],
        qualityGate: QualityGate.none(),
        mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
        reviewCommentLayout: 'table',
      });
      expect(settings.suggestEnabledRatingLabels).toEqual(['-']);
    });

    it("ratingsに '-' を含めなくても qualityGate.failureCriteria に '-' を指定できる", () => {
      const qualityGate = new QualityGate([{ ratingLabel: '-', threshold: 5 }]);
      const settings = new ReviewSettings({
        additionalInstructions: '',
        concurrentReviewCount: null,
        commentFormat: '{comment}',
        ratings: [new Rating('A', 'def'), new Rating('C', 'def3')],
        hiddenRatingLabels: [],
        suggestEnabledRatingLabels: [],
        qualityGate,
        mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
        reviewCommentLayout: 'table',
      });
      expect(settings.qualityGate.failureCriteria[0].ratingLabel).toBe('-');
    });
  });

  describe('mrCommentTitle', () => {
    it('任意の文字列を受け取って保持する', () => {
      const settings = new ReviewSettings({
        additionalInstructions: '',
        concurrentReviewCount: null,
        commentFormat: '{comment}',
        ratings: [new Rating('A', 'def')],
        hiddenRatingLabels: [],
        suggestEnabledRatingLabels: [],
        qualityGate: QualityGate.none(),
        mrCommentTitle: 'フロントエンドチェック',
        reviewCommentLayout: 'table',
      });
      expect(settings.mrCommentTitle).toBe('フロントエンドチェック');
    });

    it('空文字の場合はエラーになる', () => {
      expect(
        () =>
          new ReviewSettings({
            additionalInstructions: '',
            concurrentReviewCount: null,
            commentFormat: '{comment}',
            ratings: [new Rating('A', 'def')],
            hiddenRatingLabels: [],
            suggestEnabledRatingLabels: [],
            qualityGate: QualityGate.none(),
            mrCommentTitle: '',
            reviewCommentLayout: 'table',
          }),
      ).toThrow('mrCommentTitle must not be empty');
    });
  });

  describe('reviewCommentLayout', () => {
    const buildParams = (reviewCommentLayout: string) => ({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [new Rating('A', 'def')],
      hiddenRatingLabels: [],
      suggestEnabledRatingLabels: [],
      qualityGate: QualityGate.none(),
      mrCommentTitle: DEFAULT_MR_COMMENT_TITLE,
      reviewCommentLayout,
    });

    it("'table' を指定できる", () => {
      const settings = new ReviewSettings(
        buildParams('table') as ConstructorParameters<typeof ReviewSettings>[0],
      );
      expect(settings.reviewCommentLayout).toBe('table');
    });

    it("'sections' を指定できる", () => {
      const settings = new ReviewSettings(
        buildParams('sections') as ConstructorParameters<typeof ReviewSettings>[0],
      );
      expect(settings.reviewCommentLayout).toBe('sections');
    });

    it('未知のレイアウトを指定した場合はエラーになる', () => {
      expect(
        () =>
          new ReviewSettings(
            buildParams('unknown') as ConstructorParameters<typeof ReviewSettings>[0],
          ),
      ).toThrow('reviewCommentLayout must be one of: table, sections');
    });

    it('デフォルト設定では table になる', () => {
      expect(ReviewSettings.default().reviewCommentLayout).toBe('table');
    });
  });
});
