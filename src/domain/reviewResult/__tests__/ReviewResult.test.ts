import { describe, it, expect } from 'vitest';
import { ReviewResult } from '../ReviewResult.js';
import { CheckItem } from '../../checkItem/index.js';
import { Rating } from '../../rating/index.js';

describe('ReviewResult', () => {
  const checkItem = new CheckItem('コードの可読性');
  const rating = new Rating('A', '完全に満たしている');

  it('正常なレビュー結果を生成できる', () => {
    const result = ReviewResult.success(checkItem, rating, 'コメント内容');
    expect(result.checkItem).toBe(checkItem);
    expect(result.rating).toBe(rating);
    expect(result.comment).toBe('コメント内容');
    expect(result.isError).toBe(false);
    expect(result.errorMessage).toBeUndefined();
  });

  it('エラーのレビュー結果を生成できる', () => {
    const result = ReviewResult.error(checkItem, 'Timeout occurred');
    expect(result.checkItem).toBe(checkItem);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('Timeout occurred');
  });
});
