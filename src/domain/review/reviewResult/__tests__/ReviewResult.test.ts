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

  describe('allAreHidden', () => {
    const checkItem2 = new CheckItem('テストカバレッジ');
    const ratingA = new Rating('A', '完全に満たしている');
    const ratingB = new Rating('B', '概ね満たしている');
    const ratingC = new Rating('C', '満たしていない');

    it('全非エラー結果がhiddenRatingLabelsに該当する場合、trueを返す', () => {
      const results = [
        ReviewResult.success(checkItem, ratingA, 'Good'),
        ReviewResult.success(checkItem2, ratingA, 'Also good'),
      ];
      expect(ReviewResult.allAreHidden(results, ['A'])).toBe(true);
    });

    it('複数のhiddenRatingLabelsに該当する場合、trueを返す', () => {
      const results = [
        ReviewResult.success(checkItem, ratingA, 'Good'),
        ReviewResult.success(checkItem2, ratingB, 'OK'),
      ];
      expect(ReviewResult.allAreHidden(results, ['A', 'B'])).toBe(true);
    });

    it('hidden + 非hidden混在の場合、falseを返す', () => {
      const results = [
        ReviewResult.success(checkItem, ratingA, 'Good'),
        ReviewResult.success(checkItem2, ratingC, 'Needs work'),
      ];
      expect(ReviewResult.allAreHidden(results, ['A'])).toBe(false);
    });

    it('hidden + エラー混在の場合、falseを返す', () => {
      const results = [
        ReviewResult.success(checkItem, ratingA, 'Good'),
        ReviewResult.error(checkItem2, 'Error'),
      ];
      expect(ReviewResult.allAreHidden(results, ['A'])).toBe(false);
    });

    it('全エラーの場合、falseを返す', () => {
      const results = [
        ReviewResult.error(checkItem, 'Error 1'),
        ReviewResult.error(checkItem2, 'Error 2'),
      ];
      expect(ReviewResult.allAreHidden(results, ['A'])).toBe(false);
    });

    it('空配列の場合、falseを返す', () => {
      expect(ReviewResult.allAreHidden([], ['A'])).toBe(false);
    });

    it('hiddenRatingLabelsが空の場合、falseを返す', () => {
      const results = [ReviewResult.success(checkItem, ratingA, 'Good')];
      expect(ReviewResult.allAreHidden(results, [])).toBe(false);
    });

    it('単一の非表示結果の場合、trueを返す', () => {
      const results = [ReviewResult.success(checkItem, ratingA, 'Good')];
      expect(ReviewResult.allAreHidden(results, ['A'])).toBe(true);
    });
  });
});
