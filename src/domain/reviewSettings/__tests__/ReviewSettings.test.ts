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
      qualityGate,
    });
    expect(settings.additionalInstructions).toBe('追加指示');
    expect(settings.concurrentReviewCount).toBe(3);
    expect(settings.commentFormat).toBe('{comment}');
    expect(settings.ratings).toEqual(ratings);
    expect(settings.hiddenRatingLabels).toEqual(['A']);
    expect(settings.qualityGate).toBe(qualityGate);
  });

  it('concurrentReviewCountがnullの場合は正常に生成できる', () => {
    const settings = new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [new Rating('A', 'def')],
      hiddenRatingLabels: [],
      qualityGate: QualityGate.none(),
    });
    expect(settings.concurrentReviewCount).toBeNull();
  });

  it('デフォルト値で生成できる', () => {
    const settings = ReviewSettings.default();
    expect(settings.additionalInstructions).toBe('');
    expect(settings.concurrentReviewCount).toBeNull();
    expect(settings.commentFormat).not.toBe('');
    expect(settings.ratings.length).toBe(3);
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
          qualityGate: new QualityGate([{ ratingLabel: 'X', threshold: 1 }]),
        }),
    ).toThrow();
  });
});
