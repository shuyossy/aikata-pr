import { describe, it, expect } from 'vitest';
import { stripFilesFromFolderTree } from '../FolderTreeStripper.js';

describe('stripFilesFromFolderTree', () => {
  it('ファイルエントリを除去し、ディレクトリ構造のみ残す', () => {
    const input = [
      'src/',
      '  domain/',
      '    checkItem/',
      '      CheckItem.ts',
      '      index.ts',
      '  application/',
      '    shared/',
      '      parser/',
      '        ChecklistParser.ts',
    ].join('\n');

    const result = stripFilesFromFolderTree(input);

    const expected = [
      'src/',
      '  domain/',
      '    checkItem/',
      '  application/',
      '    shared/',
      '      parser/',
    ].join('\n');

    expect(result).toBe(expected);
  });

  it('空文字列を渡すと空文字列を返す', () => {
    expect(stripFilesFromFolderTree('')).toBe('');
  });

  it('ファイルのみの場合は空文字列を返す', () => {
    const input = ['README.md', 'package.json', 'tsconfig.json'].join('\n');

    expect(stripFilesFromFolderTree(input)).toBe('');
  });

  it('ディレクトリのみの場合はそのまま返す', () => {
    const input = ['src/', '  domain/', '  application/'].join('\n');

    expect(stripFilesFromFolderTree(input)).toBe(input);
  });

  it('深くネストされた構造を正しく処理する', () => {
    const input = [
      'a/',
      '  b/',
      '    c/',
      '      d/',
      '        file.ts',
      '      file2.ts',
      '    file3.ts',
      '  file4.ts',
    ].join('\n');

    const expected = ['a/', '  b/', '    c/', '      d/'].join('\n');

    expect(stripFilesFromFolderTree(input)).toBe(expected);
  });

  it('truncatedメッセージを保持する', () => {
    const input = ['src/', '  file.ts', '... (truncated, showing 500 of more entries)'].join('\n');

    const expected = ['src/', '... (truncated, showing 500 of more entries)'].join('\n');

    expect(stripFilesFromFolderTree(input)).toBe(expected);
  });
});
