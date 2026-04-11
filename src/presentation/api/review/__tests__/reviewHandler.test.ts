import { describe, it, expect } from 'vitest';
import { reviewRequestSchema, buildReviewSettings } from '../reviewHandler.js';

describe('reviewRequestSchema', () => {
  it('必須フィールドがすべて揃っている場合にバリデーションが通ること', () => {
    const input = {
      userId: 'alice',
      gitlabToken: 'token123',
      projectId: '42',
      mrIid: '10',
      checklist: ['item 1', 'item 2'],
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('userIdが未指定の場合にバリデーションエラーになること', () => {
    const input = {
      gitlabToken: 'token',
      projectId: '42',
      mrIid: '10',
      checklist: ['item 1'],
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('userIdが空文字の場合にバリデーションエラーになること', () => {
    const input = {
      userId: '',
      gitlabToken: 'token',
      projectId: '42',
      mrIid: '10',
      checklist: ['item 1'],
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('reviewSettingsとoptionsを含む完全なリクエストがバリデーションを通ること', () => {
    const input = {
      userId: 'alice',
      gitlabToken: 'token123',
      projectId: '42',
      mrIid: '10',
      checklist: ['item 1'],
      reviewSettings: {
        additionalInstructions: 'Be strict',
        concurrentReviewCount: 3,
        commentFormat: '## {comment}',
        ratings: [
          { label: 'A', definition: 'Excellent' },
          { label: 'C', definition: 'Poor' },
        ],
        hiddenRatingLabels: ['A'],
        qualityGate: {
          failureCriteria: [{ ratingLabel: 'C', threshold: 2 }],
        },
      },
      options: {
        commentLanguage: 'English',
        skillsPaths: ['/path/to/skills'],
        treeMaxDepth: 5,
      },
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('gitlabTokenが空文字の場合にバリデーションエラーになること', () => {
    const input = {
      gitlabToken: '',
      projectId: '42',
      mrIid: '10',
      checklist: ['item 1'],
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('checklistが空配列の場合にバリデーションエラーになること', () => {
    const input = {
      gitlabToken: 'token',
      projectId: '42',
      mrIid: '10',
      checklist: [],
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('checklistに空文字が含まれる場合にバリデーションエラーになること', () => {
    const input = {
      gitlabToken: 'token',
      projectId: '42',
      mrIid: '10',
      checklist: ['item 1', ''],
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('reviewSettings.concurrentReviewCountがnullの場合にバリデーションが通ること', () => {
    const input = {
      userId: 'alice',
      gitlabToken: 'token',
      projectId: '42',
      mrIid: '10',
      checklist: ['item 1'],
      reviewSettings: {
        concurrentReviewCount: null,
      },
    };

    const result = reviewRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe('buildReviewSettings', () => {
  it('undefinedの場合にデフォルトのReviewSettingsが返ること', () => {
    const settings = buildReviewSettings(undefined);
    expect(settings.additionalInstructions).toBe('');
    expect(settings.concurrentReviewCount).toBeNull();
    expect(settings.commentFormat).toBe('{comment}');
    expect(settings.ratings.length).toBeGreaterThan(0);
    expect(settings.hiddenRatingLabels).toEqual([]);
    expect(settings.qualityGate.failureCriteria.length).toBe(0);
  });

  it('カスタム設定が正しく変換されること', () => {
    const settings = buildReviewSettings({
      additionalInstructions: 'Be thorough',
      concurrentReviewCount: 5,
      commentFormat: '## Review\n{comment}',
      ratings: [
        { label: 'A', definition: 'Great' },
        { label: 'B', definition: 'OK' },
      ],
      hiddenRatingLabels: ['A'],
      qualityGate: {
        failureCriteria: [{ ratingLabel: 'B', threshold: 3 }],
      },
    });

    expect(settings.additionalInstructions).toBe('Be thorough');
    expect(settings.concurrentReviewCount).toBe(5);
    expect(settings.commentFormat).toBe('## Review\n{comment}');
    expect(settings.ratings).toHaveLength(2);
    expect(settings.ratings[0].label).toBe('A');
    expect(settings.hiddenRatingLabels).toEqual(['A']);
    expect(settings.qualityGate.failureCriteria).toHaveLength(1);
    expect(settings.qualityGate.failureCriteria[0].ratingLabel).toBe('B');
  });

  it('concurrentReviewCountが0以下の場合にnullに変換されること', () => {
    const settings = buildReviewSettings({
      concurrentReviewCount: 0,
    });
    expect(settings.concurrentReviewCount).toBeNull();
  });

  it('concurrentReviewCountがnullの場合にnullのままであること', () => {
    const settings = buildReviewSettings({
      concurrentReviewCount: null,
    });
    expect(settings.concurrentReviewCount).toBeNull();
  });

  it('ratings未指定の場合にデフォルトのratingsが使用されること', () => {
    const settings = buildReviewSettings({});
    expect(settings.ratings.length).toBeGreaterThan(0);
    // デフォルトのratingsと同じ
    expect(settings.ratings[0].label).toBe('A');
  });

  it('qualityGate.failureCriteria未指定の場合に品質ゲートなしとなること', () => {
    const settings = buildReviewSettings({
      qualityGate: {},
    });
    expect(settings.qualityGate.failureCriteria).toHaveLength(0);
  });

  it('qualityGate未指定の場合に品質ゲートなしとなること', () => {
    const settings = buildReviewSettings({});
    expect(settings.qualityGate.failureCriteria).toHaveLength(0);
  });
});
