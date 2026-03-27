import { describe, it, expect } from 'vitest';
import { Rating } from '../Rating.js';

describe('Rating', () => {
  it('labelとdefinitionを保持する', () => {
    const rating = new Rating('A', 'チェック項目の要件を完全に満たしている');
    expect(rating.label).toBe('A');
    expect(rating.definition).toBe('チェック項目の要件を完全に満たしている');
  });

  it('labelが空文字の場合はエラーになる', () => {
    expect(() => new Rating('', 'definition')).toThrow();
  });

  it('definitionが空文字の場合はエラーになる', () => {
    expect(() => new Rating('A', '')).toThrow();
  });

  it('同じlabelとdefinitionを持つRatingは等価である', () => {
    const a = new Rating('A', 'def');
    const b = new Rating('A', 'def');
    expect(a.equals(b)).toBe(true);
  });
});
