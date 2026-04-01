import { describe, it, expect } from 'vitest';
import { GptTokenCounter } from '../GptTokenCounter.js';

describe('GptTokenCounter', () => {
  const counter = new GptTokenCounter();

  it('空文字列のトークン数は0を返す', () => {
    expect(counter.countTokens('')).toBe(0);
  });

  it('非空文字列に対して正の整数を返す', () => {
    const tokens = counter.countTokens('Hello, world!');
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it('長いテキストは短いテキストよりトークン数が多い', () => {
    const shortText = 'Hello';
    const longText =
      'Hello, this is a much longer text that contains many more words and should result in significantly more tokens.';
    expect(counter.countTokens(longText)).toBeGreaterThan(counter.countTokens(shortText));
  });

  it('TokenCounterインターフェースを満たす', () => {
    // countTokensメソッドが存在し、呼び出し可能であることを確認
    expect(typeof counter.countTokens).toBe('function');
  });
});
