import { describe, it, expect } from 'vitest';
import { ReviewSettingsParser } from '../ReviewSettingsParser.js';
import { ReviewSettings } from '../../../../domain/reviewSettings/index.js';

describe('ReviewSettingsParser', () => {
  it('全フィールド指定のJSONをパースできる', () => {
    const json = JSON.stringify({
      additionalInstructions: 'セキュリティに注意してレビューしてください',
      concurrentReviewCount: 3,
      commentFormat: '## {comment}',
      ratings: [
        { label: 'A', definition: '完全に満たしている' },
        { label: 'B', definition: '概ね満たしている' },
      ],
    });

    const settings = ReviewSettingsParser.parse(json);

    expect(settings.additionalInstructions).toBe('セキュリティに注意してレビューしてください');
    expect(settings.concurrentReviewCount).toBe(3);
    expect(settings.commentFormat).toBe('## {comment}');
    expect(settings.ratings.length).toBe(2);
    expect(settings.ratings[0].label).toBe('A');
    expect(settings.ratings[0].definition).toBe('完全に満たしている');
    expect(settings.ratings[1].label).toBe('B');
    expect(settings.ratings[1].definition).toBe('概ね満たしている');
  });

  it('部分指定の場合はデフォルト値が適用される', () => {
    const json = JSON.stringify({
      concurrentReviewCount: 5,
    });

    const settings = ReviewSettingsParser.parse(json);
    const defaults = ReviewSettings.default();

    expect(settings.concurrentReviewCount).toBe(5);
    expect(settings.additionalInstructions).toBe(defaults.additionalInstructions);
    expect(settings.commentFormat).toBe(defaults.commentFormat);
    expect(settings.ratings).toEqual(defaults.ratings);
  });

  it('空のJSONでは全てデフォルト値になる', () => {
    const json = '{}';

    const settings = ReviewSettingsParser.parse(json);
    const defaults = ReviewSettings.default();

    expect(settings.additionalInstructions).toBe(defaults.additionalInstructions);
    expect(settings.concurrentReviewCount).toBe(defaults.concurrentReviewCount);
    expect(settings.commentFormat).toBe(defaults.commentFormat);
    expect(settings.ratings).toEqual(defaults.ratings);
  });

  it('不正なJSONではエラーになる', () => {
    expect(() => ReviewSettingsParser.parse('not json')).toThrow();
    expect(() => ReviewSettingsParser.parse('{invalid}')).toThrow();
  });

  it('concurrentReviewCountが0の場合はnullに変換される', () => {
    const settings = ReviewSettingsParser.parse(JSON.stringify({ concurrentReviewCount: 0 }));
    expect(settings.concurrentReviewCount).toBeNull();
  });

  it('concurrentReviewCountがマイナスの場合はnullに変換される', () => {
    const settings = ReviewSettingsParser.parse(JSON.stringify({ concurrentReviewCount: -1 }));
    expect(settings.concurrentReviewCount).toBeNull();
  });

  it('concurrentReviewCountが未設定の場合はnullに変換される', () => {
    const settings = ReviewSettingsParser.parse(JSON.stringify({}));
    expect(settings.concurrentReviewCount).toBeNull();
  });

  it('hiddenRatingLabelsを含むJSONをパースできる', () => {
    const json = JSON.stringify({
      ratings: [
        { label: 'A', definition: '完全に満たしている' },
        { label: 'B', definition: '概ね満たしている' },
        { label: 'C', definition: '満たしていない' },
      ],
      hiddenRatingLabels: ['A'],
    });

    const settings = ReviewSettingsParser.parse(json);

    expect(settings.hiddenRatingLabels).toEqual(['A']);
  });

  it('hiddenRatingLabels未指定の場合はデフォルト（空配列）が適用される', () => {
    const settings = ReviewSettingsParser.parse(JSON.stringify({}));
    expect(settings.hiddenRatingLabels).toEqual([]);
  });

  it('hiddenRatingLabelsにratingsに存在しないラベルがある場合エラーになる', () => {
    const json = JSON.stringify({
      ratings: [{ label: 'A', definition: '完全に満たしている' }],
      hiddenRatingLabels: ['X'],
    });
    expect(() => ReviewSettingsParser.parse(json)).toThrow();
  });
});
