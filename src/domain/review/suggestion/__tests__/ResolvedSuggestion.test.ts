import { describe, it, expect } from 'vitest';
import { ResolvedSuggestion } from '../ResolvedSuggestion.js';
import { Suggestion } from '../Suggestion.js';

describe('ResolvedSuggestion', () => {
  const validSuggestion = new Suggestion({
    checkItemContent: 'NULL安全性を確認すること',
    filePath: 'src/main.ts',
    originalCode: 'const x = null;',
    suggestedCode: 'const x: string | null = null;',
    comment: 'NULL安全性のために型注釈を追加してください',
  });

  const validParams = {
    suggestion: validSuggestion,
    newLine: 10,
    linesAbove: 2,
    linesBelow: 3,
    oldPath: 'src/main.ts',
    newPath: 'src/main.ts',
  };

  it('全てのフィールドを指定して生成できる', () => {
    const resolved = new ResolvedSuggestion(validParams);
    expect(resolved.suggestion).toBe(validSuggestion);
    expect(resolved.newLine).toBe(10);
    expect(resolved.linesAbove).toBe(2);
    expect(resolved.linesBelow).toBe(3);
    expect(resolved.oldPath).toBe('src/main.ts');
    expect(resolved.newPath).toBe('src/main.ts');
  });

  it('フィールドがreadonlyである', () => {
    const resolved = new ResolvedSuggestion(validParams);
    expect(resolved.suggestion).toBe(validSuggestion);
    expect(resolved.newLine).toBe(10);
    expect(resolved.linesAbove).toBe(2);
    expect(resolved.linesBelow).toBe(3);
    expect(resolved.oldPath).toBe('src/main.ts');
    expect(resolved.newPath).toBe('src/main.ts');
  });

  it('linesAboveとlinesBelowが0でも生成できる', () => {
    const resolved = new ResolvedSuggestion({
      ...validParams,
      linesAbove: 0,
      linesBelow: 0,
    });
    expect(resolved.linesAbove).toBe(0);
    expect(resolved.linesBelow).toBe(0);
  });

  it('newLineが1でも生成できる（境界値）', () => {
    const resolved = new ResolvedSuggestion({
      ...validParams,
      newLine: 1,
    });
    expect(resolved.newLine).toBe(1);
  });

  it('newLineが0の場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, newLine: 0 })).toThrow(
      'newLine must be >= 1',
    );
  });

  it('newLineが負数の場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, newLine: -1 })).toThrow(
      'newLine must be >= 1',
    );
  });

  it('linesAboveが負数の場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, linesAbove: -1 })).toThrow(
      'linesAbove must be >= 0',
    );
  });

  it('linesBelowが負数の場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, linesBelow: -1 })).toThrow(
      'linesBelow must be >= 0',
    );
  });

  it('linesAbove + linesBelow + 1が201の場合は生成できる（境界値）', () => {
    const resolved = new ResolvedSuggestion({
      ...validParams,
      linesAbove: 100,
      linesBelow: 100,
    });
    expect(resolved.linesAbove).toBe(100);
    expect(resolved.linesBelow).toBe(100);
  });

  it('linesAbove + linesBelow + 1が202の場合はエラーになる（境界値超過）', () => {
    expect(
      () =>
        new ResolvedSuggestion({
          ...validParams,
          linesAbove: 100,
          linesBelow: 101,
        }),
    ).toThrow('Suggestion range (linesAbove + linesBelow + 1) must not exceed 201');
  });

  it('oldPathが空文字の場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, oldPath: '' })).toThrow(
      'oldPath must not be empty',
    );
  });

  it('oldPathが空白のみの場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, oldPath: '   ' })).toThrow(
      'oldPath must not be empty',
    );
  });

  it('newPathが空文字の場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, newPath: '' })).toThrow(
      'newPath must not be empty',
    );
  });

  it('newPathが空白のみの場合はエラーになる', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, newPath: '   ' })).toThrow(
      'newPath must not be empty',
    );
  });

  it('oldPathとnewPathが異なる場合でも生成できる（リネーム対応）', () => {
    const resolved = new ResolvedSuggestion({
      ...validParams,
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    });
    expect(resolved.oldPath).toBe('src/old.ts');
    expect(resolved.newPath).toBe('src/new.ts');
  });
});
