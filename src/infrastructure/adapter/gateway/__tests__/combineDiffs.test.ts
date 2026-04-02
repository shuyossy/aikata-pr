import { describe, it, expect } from 'vitest';
import { combineDiffs } from '../combineDiffs.js';

describe('combineDiffs', () => {
  it('複数のdiffをgit diff形式のヘッダー付きで結合する', () => {
    const diffs = [
      {
        oldPath: 'file1.ts',
        newPath: 'file1.ts',
        diff: '@@ -1,3 +1,4 @@\n+import { foo } from "bar";\n',
      },
      {
        oldPath: 'file2.ts',
        newPath: 'file2.ts',
        diff: '@@ -10,3 +10,5 @@\n+export const baz = 1;\n',
      },
    ];

    const result = combineDiffs(diffs);

    expect(result).toBe(
      'diff --git a/file1.ts b/file1.ts\n--- a/file1.ts\n+++ b/file1.ts\n@@ -1,3 +1,4 @@\n+import { foo } from "bar";\n' +
        '\n' +
        'diff --git a/file2.ts b/file2.ts\n--- a/file2.ts\n+++ b/file2.ts\n@@ -10,3 +10,5 @@\n+export const baz = 1;\n',
    );
  });

  it('空のdiff配列の場合は空文字列を返す', () => {
    const result = combineDiffs([]);
    expect(result).toBe('');
  });

  it('既に --- a/ ヘッダーが含まれるdiffに対して重複ヘッダーを追加しない', () => {
    const diffs = [
      {
        oldPath: 'file.ts',
        newPath: 'file.ts',
        diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ];

    const result = combineDiffs(diffs);

    expect(result).toBe(
      'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );
  });

  it('リネームされたファイルのdiffにold_pathとnew_pathが反映される', () => {
    const diffs = [
      {
        oldPath: 'old/file.ts',
        newPath: 'new/file.ts',
        diff: '@@ -1 +1 @@\n-old\n+new\n',
      },
    ];

    const result = combineDiffs(diffs);

    expect(result).toBe(
      'diff --git a/old/file.ts b/new/file.ts\n--- a/old/file.ts\n+++ b/new/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );
  });
});
