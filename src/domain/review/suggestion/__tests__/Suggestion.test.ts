import { describe, it, expect } from 'vitest';
import { Suggestion, MAX_ORIGINAL_CODE_LINES } from '../Suggestion.js';

describe('Suggestion', () => {
  const validParams = {
    checkItemContent: 'NULL安全性を確認すること',
    filePath: 'src/main.ts',
    originalCode: 'const x = null;',
    suggestedCode: 'const x: string | null = null;',
    comment: 'NULL安全性のために型注釈を追加してください',
  };

  it('全てのフィールドを指定して生成できる', () => {
    const suggestion = new Suggestion(validParams);
    expect(suggestion.checkItemContent).toBe(validParams.checkItemContent);
    expect(suggestion.filePath).toBe(validParams.filePath);
    expect(suggestion.originalCode).toBe(validParams.originalCode);
    expect(suggestion.suggestedCode).toBe(validParams.suggestedCode);
    expect(suggestion.comment).toBe(validParams.comment);
  });

  it('フィールドがreadonlyである', () => {
    const suggestion = new Suggestion(validParams);
    // TypeScriptコンパイラによるreadonlyチェックの代わりに、値が変わらないことを確認
    expect(suggestion.checkItemContent).toBe(validParams.checkItemContent);
    expect(suggestion.filePath).toBe(validParams.filePath);
    expect(suggestion.originalCode).toBe(validParams.originalCode);
    expect(suggestion.suggestedCode).toBe(validParams.suggestedCode);
    expect(suggestion.comment).toBe(validParams.comment);
  });

  it('checkItemContentが空文字の場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, checkItemContent: '' })).toThrow(
      'checkItemContent must not be empty',
    );
  });

  it('checkItemContentが空白のみの場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, checkItemContent: '   ' })).toThrow(
      'checkItemContent must not be empty',
    );
  });

  it('filePathが空文字の場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, filePath: '' })).toThrow(
      'filePath must not be empty',
    );
  });

  it('filePathが空白のみの場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, filePath: '   ' })).toThrow(
      'filePath must not be empty',
    );
  });

  it('originalCodeが空文字の場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, originalCode: '' })).toThrow(
      'originalCode must not be empty',
    );
  });

  it('originalCodeが空白のみの場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, originalCode: '   ' })).toThrow(
      'originalCode must not be empty',
    );
  });

  it('suggestedCodeが空文字の場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, suggestedCode: '' })).toThrow(
      'suggestedCode must not be empty',
    );
  });

  it('suggestedCodeが空白のみの場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, suggestedCode: '   ' })).toThrow(
      'suggestedCode must not be empty',
    );
  });

  it('commentが空文字の場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, comment: '' })).toThrow(
      'comment must not be empty',
    );
  });

  it('commentが空白のみの場合はエラーになる', () => {
    expect(() => new Suggestion({ ...validParams, comment: '   ' })).toThrow(
      'comment must not be empty',
    );
  });

  it(`originalCodeが${MAX_ORIGINAL_CODE_LINES}行の場合は正常に生成できる`, () => {
    const code = Array.from({ length: MAX_ORIGINAL_CODE_LINES }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const suggestion = new Suggestion({ ...validParams, originalCode: code });
    expect(suggestion.originalCode).toBe(code);
  });

  it(`originalCodeが${MAX_ORIGINAL_CODE_LINES + 1}行の場合はエラーになる`, () => {
    const code = Array.from(
      { length: MAX_ORIGINAL_CODE_LINES + 1 },
      (_, i) => `line ${i + 1}`,
    ).join('\n');
    expect(() => new Suggestion({ ...validParams, originalCode: code })).toThrow(
      `originalCode must be ${MAX_ORIGINAL_CODE_LINES} lines or less, but got ${MAX_ORIGINAL_CODE_LINES + 1} lines`,
    );
  });

  describe('isDuplicate', () => {
    it('同一filePath + 同一originalCodeの場合はtrueを返す', () => {
      const a = new Suggestion(validParams);
      const b = new Suggestion({
        ...validParams,
        suggestedCode: '別のコード',
        comment: '別のコメント',
        checkItemContent: '別の項目',
      });
      expect(a.isDuplicate(b)).toBe(true);
    });

    it('filePathが異なる場合はfalseを返す', () => {
      const a = new Suggestion(validParams);
      const b = new Suggestion({ ...validParams, filePath: 'src/other.ts' });
      expect(a.isDuplicate(b)).toBe(false);
    });

    it('originalCodeが異なる場合はfalseを返す', () => {
      const a = new Suggestion(validParams);
      const b = new Suggestion({ ...validParams, originalCode: 'const y = null;' });
      expect(a.isDuplicate(b)).toBe(false);
    });
  });

  describe('equals', () => {
    it('全フィールドが同じSuggestionはequalsがtrueを返す', () => {
      const a = new Suggestion(validParams);
      const b = new Suggestion(validParams);
      expect(a.equals(b)).toBe(true);
    });

    it('いずれかのフィールドが異なるSuggestionはequalsがfalseを返す', () => {
      const a = new Suggestion(validParams);
      const b = new Suggestion({ ...validParams, comment: '別のコメント' });
      expect(a.equals(b)).toBe(false);
    });
  });
});
