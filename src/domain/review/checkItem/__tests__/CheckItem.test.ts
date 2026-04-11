import { describe, it, expect } from 'vitest';
import { CheckItem } from '../CheckItem.js';

describe('CheckItem', () => {
  it('contentを保持する', () => {
    const item = new CheckItem('コードの可読性が保たれているか');
    expect(item.content).toBe('コードの可読性が保たれているか');
  });

  it('contentが空文字の場合はエラーになる', () => {
    expect(() => new CheckItem('')).toThrow();
  });

  it('同じcontentを持つCheckItemは等価である', () => {
    const a = new CheckItem('test');
    const b = new CheckItem('test');
    expect(a.equals(b)).toBe(true);
  });

  it('異なるcontentを持つCheckItemは等価でない', () => {
    const a = new CheckItem('test1');
    const b = new CheckItem('test2');
    expect(a.equals(b)).toBe(false);
  });
});
