import { describe, it, expect } from 'vitest';
import { ReviewSettings } from '../ReviewSettings.js';
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
    });
    expect(settings.additionalInstructions).toBe('追加指示');
    expect(settings.concurrentReviewCount).toBe(3);
    expect(settings.commentFormat).toBe('{comment}');
    expect(settings.ratings).toEqual(ratings);
    expect(settings.hiddenRatingLabels).toEqual(['A']);
    expect(settings.suggestEnabledRatingLabels).toEqual(['B']);
    expect(settings.qualityGate).toBe(qualityGate);
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
          }),
      ).toThrow('suggestEnabledRatingLabels contains unknown label: X');
    });
  });
});
