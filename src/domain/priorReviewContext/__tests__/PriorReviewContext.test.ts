import { describe, it, expect } from 'vitest';
import { PriorReviewContext } from '../PriorReviewContext.js';
import { ReviewResult } from '../../reviewResult/index.js';
import { CheckItem } from '../../checkItem/index.js';
import { Rating } from '../../rating/index.js';

describe('PriorReviewContext', () => {
  it('前回レビュー結果とその後の変更情報を保持する', () => {
    const result = ReviewResult.success(new CheckItem('item'), new Rating('A', 'good'), 'comment');
    const ctx = new PriorReviewContext({
      results: [result],
      commitMessages: ['fix: something'],
      diffSincePrior: '--- a/file\n+++ b/file',
    });
    expect(ctx.results).toHaveLength(1);
    expect(ctx.commitMessages).toEqual(['fix: something']);
    expect(ctx.diffSincePrior).toBe('--- a/file\n+++ b/file');
  });
});
