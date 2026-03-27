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
    });
    expect(settings.additionalInstructions).toBe('追加指示');
    expect(settings.concurrentReviewCount).toBe(3);
    expect(settings.commentFormat).toBe('{comment}');
    expect(settings.ratings).toEqual(ratings);
  });

  it('デフォルト値で生成できる', () => {
    const settings = ReviewSettings.default();
    expect(settings.additionalInstructions).toBe('');
    expect(settings.concurrentReviewCount).toBe(1);
    expect(settings.commentFormat).not.toBe('');
    expect(settings.ratings.length).toBe(3);
  });

  it('concurrentReviewCountが0以下の場合はエラーになる', () => {
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: 0,
          commentFormat: '{comment}',
          ratings: [new Rating('A', 'def')],
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
        }),
    ).toThrow();
  });
});
