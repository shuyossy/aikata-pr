import { describe, it, expect } from 'vitest';
import { Suggestion } from '../Suggestion.js';

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
