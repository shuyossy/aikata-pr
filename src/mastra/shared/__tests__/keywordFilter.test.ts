import { describe, it, expect } from 'vitest';
import { filterByKeywords } from '../keywordFilter.js';

const sampleText = [
  'line 0: alpha',
  'line 1: beta',
  'line 2: gamma',
  'line 3: delta',
  'line 4: ERROR found',
  'line 5: epsilon',
  'line 6: zeta',
  'line 7: eta',
  'line 8: WARNING detected',
  'line 9: theta',
  'line 10: iota',
].join('\n');

describe('filterByKeywords', () => {
  it('単一キーワードでマッチする行と周辺コンテキストを返す', () => {
    const result = filterByKeywords(sampleText, ['ERROR']);

    expect(result.hasMatches).toBe(true);
    expect(result.filteredText).toContain('ERROR found');
  });

  it('複数キーワードでOR検索する', () => {
    const result = filterByKeywords(sampleText, ['ERROR', 'WARNING']);

    expect(result.hasMatches).toBe(true);
    expect(result.filteredText).toContain('ERROR found');
    expect(result.filteredText).toContain('WARNING detected');
  });

  it('大文字小文字を無視して検索する', () => {
    const result = filterByKeywords(sampleText, ['error']);

    expect(result.hasMatches).toBe(true);
    expect(result.filteredText).toContain('ERROR found');
  });

  it('マッチしない場合はhasMatches=falseで空文字列を返す', () => {
    const result = filterByKeywords(sampleText, ['nonexistent']);

    expect(result.hasMatches).toBe(false);
    expect(result.filteredText).toBe('');
  });

  it('contextLinesでコンテキスト行数を制御できる', () => {
    const result = filterByKeywords(sampleText, ['ERROR'], 1);

    expect(result.hasMatches).toBe(true);
    // ERROR (index 4) の前後1行
    expect(result.filteredText).toContain('line 3: delta');
    expect(result.filteredText).toContain('ERROR found');
    expect(result.filteredText).toContain('line 5: epsilon');
    // 範囲外は含まれない
    expect(result.filteredText).not.toContain('line 2: gamma');
  });

  it('デフォルトのcontextLinesは3行', () => {
    const result = filterByKeywords(sampleText, ['ERROR']);

    // ERROR (index 4) の前後3行
    expect(result.filteredText).toContain('line 1: beta');
    expect(result.filteredText).toContain('ERROR found');
    expect(result.filteredText).toContain('line 7: eta');
  });

  it('非連続範囲間に省略マーカーを挿入する', () => {
    const result = filterByKeywords(sampleText, ['alpha', 'iota'], 0);

    expect(result.hasMatches).toBe(true);
    expect(result.filteredText).toContain('line 0: alpha');
    expect(result.filteredText).toContain('...');
    expect(result.filteredText).toContain('line 10: iota');
  });

  it('contextLines=0でマッチ行のみ返す', () => {
    const result = filterByKeywords(sampleText, ['ERROR'], 0);

    expect(result.filteredText).toContain('line 4: ERROR found');
    // マッチ行以外は含まれない
    expect(result.filteredText).not.toContain('line 3: delta');
    expect(result.filteredText).not.toContain('line 5: epsilon');
  });

  it('境界値: テキストの先頭行がマッチする場合', () => {
    const result = filterByKeywords(sampleText, ['alpha'], 1);

    expect(result.hasMatches).toBe(true);
    expect(result.filteredText).toContain('line 0: alpha');
    expect(result.filteredText).toContain('line 1: beta');
  });

  it('境界値: テキストの末尾行がマッチする場合', () => {
    const result = filterByKeywords(sampleText, ['iota'], 1);

    expect(result.hasMatches).toBe(true);
    expect(result.filteredText).toContain('line 9: theta');
    expect(result.filteredText).toContain('line 10: iota');
  });
});
