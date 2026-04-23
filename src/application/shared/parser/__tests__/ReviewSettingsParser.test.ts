import { describe, it, expect } from 'vitest';
import { ReviewSettingsParser } from '../ReviewSettingsParser.js';
import { ReviewSettings } from '../../../../domain/review/reviewSettings/index.js';

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
      suggestEnabledRatingLabels: ['B'],
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
    expect(settings.suggestEnabledRatingLabels).toEqual(['B']);
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

  it('concurrentReviewCountがnullの場合はnullに変換される', () => {
    const settings = ReviewSettingsParser.parse(JSON.stringify({ concurrentReviewCount: null }));
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

  it('qualityGateを含むJSONをパースできる', () => {
    const json = JSON.stringify({
      ratings: [
        { label: 'A', definition: '完全に満たしている' },
        { label: 'C', definition: '満たしていない' },
      ],
      qualityGate: {
        failureCriteria: [{ ratingLabel: 'C', threshold: 1 }],
      },
    });

    const settings = ReviewSettingsParser.parse(json);

    expect(settings.qualityGate.failureCriteria).toEqual([{ ratingLabel: 'C', threshold: 1 }]);
  });

  it('qualityGate未指定の場合はデフォルト（基準なし）が適用される', () => {
    const settings = ReviewSettingsParser.parse(JSON.stringify({}));
    expect(settings.qualityGate.failureCriteria).toEqual([]);
  });

  it('qualityGateに複数の基準を指定できる', () => {
    const json = JSON.stringify({
      ratings: [
        { label: 'B', definition: '概ね満たしている' },
        { label: 'C', definition: '満たしていない' },
      ],
      qualityGate: {
        failureCriteria: [
          { ratingLabel: 'C', threshold: 1 },
          { ratingLabel: 'B', threshold: 3 },
        ],
      },
    });

    const settings = ReviewSettingsParser.parse(json);
    expect(settings.qualityGate.failureCriteria).toHaveLength(2);
  });

  it('qualityGateのthresholdが0以下の場合はエラーになる', () => {
    const json = JSON.stringify({
      qualityGate: {
        failureCriteria: [{ ratingLabel: 'C', threshold: 0 }],
      },
    });
    expect(() => ReviewSettingsParser.parse(json)).toThrow();
  });

  it('qualityGateのratingLabelが空文字の場合はエラーになる', () => {
    const json = JSON.stringify({
      qualityGate: {
        failureCriteria: [{ ratingLabel: '', threshold: 1 }],
      },
    });
    expect(() => ReviewSettingsParser.parse(json)).toThrow();
  });

  it('qualityGateのratingLabelがratingsに存在しない場合はエラーになる', () => {
    const json = JSON.stringify({
      ratings: [{ label: 'A', definition: '完全に満たしている' }],
      qualityGate: {
        failureCriteria: [{ ratingLabel: 'X', threshold: 1 }],
      },
    });
    expect(() => ReviewSettingsParser.parse(json)).toThrow();
  });

  describe('mrCommentTitle', () => {
    it('指定された値がReviewSettingsに反映される', () => {
      const json = JSON.stringify({ mrCommentTitle: 'API基盤チェック' });
      const settings = ReviewSettingsParser.parse(json);
      expect(settings.mrCommentTitle).toBe('API基盤チェック');
    });

    it('未指定の場合はデフォルト値が適用される', () => {
      const settings = ReviewSettingsParser.parse('{}');
      expect(settings.mrCommentTitle).toBe(ReviewSettings.default().mrCommentTitle);
    });

    it('空文字が指定された場合はバリデーションエラーになる', () => {
      const json = JSON.stringify({ mrCommentTitle: '' });
      expect(() => ReviewSettingsParser.parse(json)).toThrow();
    });
  });
});
