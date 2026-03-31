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

  describe('allAreErrors', () => {
    const checkItem2 = new CheckItem('テストカバレッジ');
    const rating2 = new Rating('B', '概ね満たしている');

    it('全てのレビュー結果がエラーの場合、trueを返す', () => {
      const results = [
        ReviewResult.error(checkItem, 'Error 1'),
        ReviewResult.error(checkItem2, 'Error 2'),
      ];
      expect(ReviewResult.allAreErrors(results)).toBe(true);
    });

    it('一部が成功の場合、falseを返す', () => {
      const results = [
        ReviewResult.success(checkItem, rating, 'Good'),
        ReviewResult.error(checkItem2, 'Error'),
      ];
      expect(ReviewResult.allAreErrors(results)).toBe(false);
    });

    it('全て成功の場合、falseを返す', () => {
      const results = [
        ReviewResult.success(checkItem, rating, 'Good'),
        ReviewResult.success(checkItem2, rating2, 'Also good'),
      ];
      expect(ReviewResult.allAreErrors(results)).toBe(false);
    });

    it('空配列の場合、falseを返す', () => {
      expect(ReviewResult.allAreErrors([])).toBe(false);
    });

    it('単一のエラー結果の場合、trueを返す', () => {
      const results = [ReviewResult.error(checkItem, 'Error')];
      expect(ReviewResult.allAreErrors(results)).toBe(true);
    });
  });
});
