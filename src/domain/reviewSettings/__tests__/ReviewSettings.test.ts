import { describe, it, expect } from 'vitest';
import { ReviewSettings } from '../ReviewSettings.js';
import { Rating } from '../../rating/index.js';

describe('ReviewSettings', () => {
  it('全てのフィールドを指定して生成できる', () => {
    const ratings = [new Rating('A', '完全に満たしている'), new Rating('B', '概ね満たしている')];
    const settings = new ReviewSettings({
      additionalInstructions: '追加指示',
      concurrentReviewCount: 3,
      commentFormat: '{comment}',
      ratings,
      hiddenRatingLabels: ['A'],
    });
    expect(settings.additionalInstructions).toBe('追加指示');
    expect(settings.concurrentReviewCount).toBe(3);
    expect(settings.commentFormat).toBe('{comment}');
    expect(settings.ratings).toEqual(ratings);
    expect(settings.hiddenRatingLabels).toEqual(['A']);
  });

  it('concurrentReviewCountがnullの場合は正常に生成できる', () => {
    const settings = new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [new Rating('A', 'def')],
      hiddenRatingLabels: [],
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
        }),
    ).toThrow();
  });
});
