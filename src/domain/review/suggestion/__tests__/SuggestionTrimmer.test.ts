import { describe, it, expect } from 'vitest';
import { trimCommonLines } from '../SuggestionTrimmer.js';

describe('trimCommonLines', () => {
  it('先頭と末尾の共通行を除去して変更部分のみ残す', () => {
    const originalCode = ['line1', 'line2', 'OLD', 'line4', 'line5'].join('\n');
    const suggestedCode = ['line1', 'line2', 'NEW', 'line4', 'line5'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe('OLD');
    expect(result!.trimmedSuggestedCode).toBe('NEW');
    expect(result!.leadingTrimmedCount).toBe(2);
  });

  it('先頭のみ共通行がある場合は先頭を除去する', () => {
    const originalCode = ['common1', 'common2', 'OLD1', 'OLD2'].join('\n');
    const suggestedCode = ['common1', 'common2', 'NEW1', 'NEW2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe(['OLD1', 'OLD2'].join('\n'));
    expect(result!.trimmedSuggestedCode).toBe(['NEW1', 'NEW2'].join('\n'));
    expect(result!.leadingTrimmedCount).toBe(2);
  });

  it('末尾のみ共通行がある場合は末尾を除去する', () => {
    const originalCode = ['OLD1', 'OLD2', 'common1', 'common2'].join('\n');
    const suggestedCode = ['NEW1', 'NEW2', 'common1', 'common2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe(['OLD1', 'OLD2'].join('\n'));
    expect(result!.trimmedSuggestedCode).toBe(['NEW1', 'NEW2'].join('\n'));
    expect(result!.leadingTrimmedCount).toBe(0);
  });

  it('共通行がない場合はnullを返す', () => {
    const originalCode = 'OLD_LINE';
    const suggestedCode = 'NEW_LINE';

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).toBeNull();
  });

  it('全行が同一の場合はnullを返す', () => {
    const code = ['line1', 'line2', 'line3'].join('\n');

    const result = trimCommonLines(code, code);

    expect(result).toBeNull();
  });

  it('1行のみで内容が異なる場合はnullを返す', () => {
    const result = trimCommonLines('OLD', 'NEW');

    expect(result).toBeNull();
  });

  it('suggestedCodeの行数がoriginalCodeより多い場合も正しくトリミングする', () => {
    const originalCode = ['common1', 'OLD', 'common2'].join('\n');
    const suggestedCode = ['common1', 'NEW1', 'NEW2', 'NEW3', 'common2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe('OLD');
    expect(result!.trimmedSuggestedCode).toBe(['NEW1', 'NEW2', 'NEW3'].join('\n'));
    expect(result!.leadingTrimmedCount).toBe(1);
  });

  it('suggestedCodeの行数がoriginalCodeより少ない場合も正しくトリミングする', () => {
    const originalCode = ['common1', 'OLD1', 'OLD2', 'OLD3', 'common2'].join('\n');
    const suggestedCode = ['common1', 'NEW', 'common2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe(['OLD1', 'OLD2', 'OLD3'].join('\n'));
    expect(result!.trimmedSuggestedCode).toBe('NEW');
    expect(result!.leadingTrimmedCount).toBe(1);
  });

  it('末尾改行がある場合も正しく処理する', () => {
    const originalCode = 'common1\nOLD\ncommon2\n';
    const suggestedCode = 'common1\nNEW\ncommon2\n';

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe('OLD');
    expect(result!.trimmedSuggestedCode).toBe('NEW');
    expect(result!.leadingTrimmedCount).toBe(1);
  });

  it('中央に空行を含む場合も正しくトリミングする', () => {
    const originalCode = ['common1', '', 'OLD', '', 'common2'].join('\n');
    const suggestedCode = ['common1', '', 'NEW', '', 'common2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe('OLD');
    expect(result!.trimmedSuggestedCode).toBe('NEW');
    expect(result!.leadingTrimmedCount).toBe(2);
  });

  it('先頭のみ異なる場合は末尾の共通行を除去する', () => {
    const originalCode = ['OLD', 'common1', 'common2'].join('\n');
    const suggestedCode = ['NEW', 'common1', 'common2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe('OLD');
    expect(result!.trimmedSuggestedCode).toBe('NEW');
    expect(result!.leadingTrimmedCount).toBe(0);
  });

  it('末尾のみ異なる場合は先頭の共通行を除去する', () => {
    const originalCode = ['common1', 'common2', 'OLD'].join('\n');
    const suggestedCode = ['common1', 'common2', 'NEW'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe('OLD');
    expect(result!.trimmedSuggestedCode).toBe('NEW');
    expect(result!.leadingTrimmedCount).toBe(2);
  });

  it('複数行が変更されている場合も正しくトリミングする', () => {
    const originalCode = ['common1', 'OLD1', 'OLD2', 'common2'].join('\n');
    const suggestedCode = ['common1', 'NEW1', 'NEW2', 'common2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).not.toBeNull();
    expect(result!.trimmedOriginalCode).toBe(['OLD1', 'OLD2'].join('\n'));
    expect(result!.trimmedSuggestedCode).toBe(['NEW1', 'NEW2'].join('\n'));
    expect(result!.leadingTrimmedCount).toBe(1);
  });

  it('全行異なる複数行の場合はnullを返す', () => {
    const originalCode = ['OLD1', 'OLD2'].join('\n');
    const suggestedCode = ['NEW1', 'NEW2'].join('\n');

    const result = trimCommonLines(originalCode, suggestedCode);

    expect(result).toBeNull();
  });
});
