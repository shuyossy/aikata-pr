import { describe, it, expect } from 'vitest';
import { DiffBasedSuggestionLineResolver } from '../DiffBasedSuggestionLineResolver.js';

describe('DiffBasedSuggestionLineResolver', () => {
  const resolver = new DiffBasedSuggestionLineResolver();

  // --- テスト用diffデータ ---
  const simpleDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;`;

  const multiHunkDiff = `diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,5 @@
 import { foo } from 'bar';

-function old1() {}
+function new1() {}

 const x = 10;
@@ -10,5 +10,6 @@
 const y = 20;

-function old2() {}
+function new2() {}
+function new3() {}

 const z = 30;`;

  const renameDiff = `diff --git a/src/old-name.ts b/src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
 export const greeting = 'hello';
-export const farewell = 'bye';
+export const farewell = 'goodbye';
 export const thanks = 'thank you';`;

  const newFileDiff = `diff --git a/src/brand-new.ts b/src/brand-new.ts
--- /dev/null
+++ b/src/brand-new.ts
@@ -0,0 +1,4 @@
+export const alpha = 1;
+export const beta = 2;
+export const gamma = 3;
+export const delta = 4;`;

  const multiFileDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
diff --git a/src/utils.ts b/src/utils.ts
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
 const x = 10;
-const y = 20;
+const y = 21;
+const y2 = 22;
 const z = 30;`;

  const duplicateContentDiff = `diff --git a/src/repeat.ts b/src/repeat.ts
--- a/src/repeat.ts
+++ b/src/repeat.ts
@@ -1,5 +1,5 @@
 console.log('start');
-const val = 1;
+const val = 2;
 console.log('middle');
-const val = 1;
+const val = 2;
 console.log('end');`;

  describe('単一行マッチ', () => {
    it('変更された行（+行）にマッチする', () => {
      const result = resolver.resolve('src/index.ts', 'const b = 3;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('コンテキスト行（スペースプレフィックス）にマッチする', () => {
      const result = resolver.resolve('src/index.ts', 'const a = 1;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });
  });

  describe('複数行マッチ', () => {
    it('連続する複数行にマッチする', () => {
      const result = resolver.resolve('src/index.ts', 'const b = 3;\nconst c = 4;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 1,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('全行にマッチする', () => {
      const result = resolver.resolve(
        'src/index.ts',
        'const a = 1;\nconst b = 3;\nconst c = 4;',
        simpleDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 2,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });
  });

  describe('ファイルが見つからない場合', () => {
    it('存在しないファイルパスでエラーを返す', () => {
      const result = resolver.resolve('src/nonexistent.ts', 'const a = 1;', simpleDiff);

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('nonexistent.ts'),
      });
    });
  });

  describe('コードが見つからない場合', () => {
    it('diff内に存在しないコードでエラーを返す', () => {
      const result = resolver.resolve('src/index.ts', 'const unknown = 999;', simpleDiff);

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('Code not found in diff'),
      });
      expect(result.errorMessage).toContain('src/index.ts');
    });

    it('削除行（-行）のみに存在するコードはマッチしない', () => {
      const result = resolver.resolve('src/index.ts', 'const b = 2;', simpleDiff);

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('Code not found in diff'),
      });
    });
  });

  describe('複数マッチの場合', () => {
    it('同じコードが複数箇所にマッチした場合エラーを返す', () => {
      const result = resolver.resolve('src/repeat.ts', 'const val = 2;', duplicateContentDiff);

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('2 matches'),
      });
      expect(result.errorMessage).toContain('src/repeat.ts');
    });
  });

  describe('複数ハンクのdiff', () => {
    it('2つ目のハンク内の行に正しくマッチする', () => {
      const result = resolver.resolve('src/utils.ts', 'function new2() {}', multiHunkDiff);

      expect(result).toEqual({
        success: true,
        newLine: 12,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/utils.ts',
        newPath: 'src/utils.ts',
      });
    });

    it('1つ目のハンク内の行にも正しくマッチする', () => {
      const result = resolver.resolve('src/utils.ts', 'function new1() {}', multiHunkDiff);

      expect(result).toEqual({
        success: true,
        newLine: 3,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/utils.ts',
        newPath: 'src/utils.ts',
      });
    });

    it('2つ目のハンクで追加された新行に正しくマッチする', () => {
      const result = resolver.resolve('src/utils.ts', 'function new3() {}', multiHunkDiff);

      expect(result).toEqual({
        success: true,
        newLine: 13,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/utils.ts',
        newPath: 'src/utils.ts',
      });
    });
  });

  describe('ファイルリネーム', () => {
    it('oldPathとnewPathが正しく設定される', () => {
      const result = resolver.resolve(
        'src/new-name.ts',
        "export const farewell = 'goodbye';",
        renameDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/old-name.ts',
        newPath: 'src/new-name.ts',
      });
    });
  });

  describe('新規ファイル（追加のみ）', () => {
    it('新規ファイルの追加行にマッチする', () => {
      const result = resolver.resolve('src/brand-new.ts', 'export const alpha = 1;', newFileDiff);

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: '/dev/null',
        newPath: 'src/brand-new.ts',
      });
    });

    it('新規ファイルの複数行にマッチする', () => {
      const result = resolver.resolve(
        'src/brand-new.ts',
        'export const beta = 2;\nexport const gamma = 3;',
        newFileDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 1,
        oldPath: '/dev/null',
        newPath: 'src/brand-new.ts',
      });
    });
  });

  describe('複数ファイルのdiff', () => {
    it('2つ目のファイルのコードに正しくマッチする', () => {
      const result = resolver.resolve('src/utils.ts', 'const y = 21;', multiFileDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/utils.ts',
        newPath: 'src/utils.ts',
      });
    });
  });

  describe('ファイルパスの柔軟なマッチング', () => {
    it('パスのサフィックスでマッチする', () => {
      const result = resolver.resolve('index.ts', 'const b = 3;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });
  });

  describe('エッジケース', () => {
    it('空のdiffの場合エラーを返す', () => {
      const result = resolver.resolve('src/index.ts', 'const a = 1;', '');

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('src/index.ts'),
      });
    });

    it('空のoriginalCodeの場合エラーを返す', () => {
      const result = resolver.resolve('src/index.ts', '', simpleDiff);

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('originalCode is empty'),
      });
    });

    it('originalCodeの末尾に改行がある場合でも正しくマッチする', () => {
      const result = resolver.resolve('src/index.ts', 'const b = 3;\n', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('ハンク跨ぎの連続行ではマッチしない', () => {
      // 1つ目のハンクの最後の行と2つ目のハンクの最初の行は連続していない
      const result = resolver.resolve(
        'src/utils.ts',
        'const x = 10;\nconst y = 20;',
        multiHunkDiff,
      );

      // これらは別のハンクにあるので連続しておらず、マッチしないはず
      expect(result.success).toBe(false);
    });
  });

  // --- 長い行を含むテスト用diffデータ ---
  const longLineDiff = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,5 +1,5 @@
 import { something } from 'somewhere';

-const config = { apiUrl: 'http://old-api.example.com', timeout: 3000, retryCount: 3, debug: false };
+const config = { apiUrl: 'http://new-api.example.com', timeout: 5000, retryCount: 5, debug: true, verbose: true };

 export default config;`;

  const longLineMultiHunkDiff = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,5 +1,5 @@
 import { something } from 'somewhere';

-const config = { apiUrl: 'http://old-api.example.com', timeout: 3000, retryCount: 3, debug: false };
+const config = { apiUrl: 'http://new-api.example.com', timeout: 5000, retryCount: 5, debug: true, verbose: true };

 export default config;
@@ -10,3 +10,3 @@
 const another = 'value';
-const settings = { apiUrl: 'http://old-api.example.com', timeout: 3000, retryCount: 3, debug: false };
+const settings = { apiUrl: 'http://new-api.example.com', timeout: 5000, retryCount: 5, debug: true, verbose: true };
 const end = true;`;

  describe('部分行マッチフォールバック', () => {
    it('最初の行が途中から指定された場合（サフィックスマッチ）にマッチする', () => {
      const result = resolver.resolve(
        'src/config.ts',
        'timeout: 5000, retryCount: 5, debug: true, verbose: true };',
        longLineDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 3,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/config.ts',
        newPath: 'src/config.ts',
      });
    });

    it('最後の行が途中で途切れた場合（プレフィックスマッチ）にマッチする', () => {
      const result = resolver.resolve(
        'src/config.ts',
        "import { something } from 'somewhere';\n\nconst config = { apiUrl: 'http://new-api.example.com'",
        longLineDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 2,
        oldPath: 'src/config.ts',
        newPath: 'src/config.ts',
      });
    });

    it('単一行の部分文字列マッチにマッチする', () => {
      const result = resolver.resolve(
        'src/config.ts',
        "apiUrl: 'http://new-api.example.com', timeout: 5000",
        longLineDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 3,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/config.ts',
        newPath: 'src/config.ts',
      });
    });

    it('最初の行と最後の行が両方部分マッチする場合にマッチする', () => {
      const result = resolver.resolve(
        'src/config.ts',
        'timeout: 5000, retryCount: 5, debug: true, verbose: true };\n\nexport default',
        longLineDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 3,
        linesAbove: 0,
        linesBelow: 2,
        oldPath: 'src/config.ts',
        newPath: 'src/config.ts',
      });
    });

    it('中間行が完全一致しない場合はマッチしない', () => {
      const result = resolver.resolve(
        'src/config.ts',
        'timeout: 5000, retryCount: 5, debug: true, verbose: true };\nNOT_MATCHING_LINE\nexport default',
        longLineDiff,
      );

      expect(result.success).toBe(false);
    });

    it('最小長要件を満たさない短い部分文字列はマッチしない', () => {
      // "true" は4文字なので最小長10文字未満 → 部分マッチ対象外
      const result = resolver.resolve('src/config.ts', 'true', longLineDiff);

      expect(result.success).toBe(false);
    });

    it('部分マッチで複数マッチの場合エラーを返す', () => {
      // longLineMultiHunkDiffでは同じ長い行が2つのハンクに存在する
      const result = resolver.resolve(
        'src/config.ts',
        'timeout: 5000, retryCount: 5, debug: true, verbose: true };',
        longLineMultiHunkDiff,
      );

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('2 matches'),
      });
      expect(result.errorMessage).toContain('partial line matching');
    });

    it('完全一致が優先される（部分マッチは不使用）', () => {
      // 完全な行を指定した場合は完全一致で見つかるべき
      const result = resolver.resolve(
        'src/config.ts',
        "const config = { apiUrl: 'http://new-api.example.com', timeout: 5000, retryCount: 5, debug: true, verbose: true };",
        longLineDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 3,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/config.ts',
        newPath: 'src/config.ts',
      });
    });

    it('ハンク境界を跨ぐ部分マッチは行わない', () => {
      // 1つ目のハンクの最後の行（部分マッチ）と2つ目のハンクの最初の行は連続していない
      const result = resolver.resolve(
        'src/config.ts',
        "verbose: true };\nconst another = 'value';",
        longLineMultiHunkDiff,
      );

      expect(result.success).toBe(false);
    });
  });

  describe('全空白除去フォールバックマッチ', () => {
    it('先頭空白が異なるoriginalCodeでフォールバック成功する（単一行）', () => {
      // diffでは "const b = 3;" だが、agentが "  const b = 3;" を指定
      const result = resolver.resolve('src/index.ts', '  const b = 3;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('先頭空白が異なるoriginalCodeでフォールバック成功する（複数行）', () => {
      // diffでは各行にインデントなしだが、agentが4スペースインデントで指定
      const result = resolver.resolve(
        'src/index.ts',
        '    const a = 1;\n    const b = 3;\n    const c = 4;',
        simpleDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 2,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('タブvs空白の差異でフォールバック成功する', () => {
      // diffでは "const b = 3;" だが、agentがタブでインデント
      const result = resolver.resolve('src/index.ts', '\tconst b = 3;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('内部空白差異でフォールバック成功する', () => {
      // diffでは "const b = 3;" だが、agentが "const  b  =  3;" を指定
      const result = resolver.resolve('src/index.ts', 'const  b  =  3;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('改行位置の違いでフォールバック成功する', () => {
      // diffでは2行だが、agentが1行にまとめて指定
      const result = resolver.resolve(
        'src/brand-new.ts',
        'export const alpha = 1; export const beta = 2;',
        newFileDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 1,
        oldPath: '/dev/null',
        newPath: 'src/brand-new.ts',
      });
    });

    it('agentが多くの行に分割した場合もフォールバック成功する（diffでは少ない行数）', () => {
      // diffでは "export const alpha = 1;" が1行だが、agentが2行に分割
      // → 正規化すると同じなのでdiff側の1行にマッチ
      const result = resolver.resolve('src/brand-new.ts', 'export const\nalpha = 1;', newFileDiff);

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: '/dev/null',
        newPath: 'src/brand-new.ts',
      });
    });

    it('\\r\\nと\\nの差異でフォールバック成功する', () => {
      const result = resolver.resolve(
        'src/index.ts',
        'const a = 1;\r\nconst b = 3;\r\nconst c = 4;\r\n',
        simpleDiff,
      );

      expect(result).toEqual({
        success: true,
        newLine: 1,
        linesAbove: 0,
        linesBelow: 2,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('正規化マッチで複数マッチした場合エラーを返す', () => {
      // duplicateContentDiffにはconst val = 2;が2箇所
      // 空白違いで指定しても2箇所マッチ→エラー
      const result = resolver.resolve('src/repeat.ts', '  const val = 2;', duplicateContentDiff);

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('2 matches'),
      });
      expect(result.errorMessage).toContain('ignoring whitespace');
    });

    it('正規化マッチでも0件の場合エラーを返す', () => {
      const result = resolver.resolve('src/index.ts', 'completely different code', simpleDiff);

      expect(result).toEqual({
        success: false,
        errorMessage: expect.stringContaining('Code not found in diff'),
      });
      expect(result.errorMessage).toContain('even after ignoring all whitespace');
    });

    it('完全一致が成功する場合はフォールバック不使用（既存動作維持）', () => {
      // 完全一致でマッチする場合はlinesBelow計算がcodeLines.length-1ベース
      const result = resolver.resolve('src/index.ts', 'const b = 3;\nconst c = 4;', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 1, // codeLines.length(2) - 1 = 1
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });

    it('末尾空白の差異でフォールバック成功する', () => {
      // diffでは "const b = 3;" だが、agentが末尾にスペースを付けた
      const result = resolver.resolve('src/index.ts', 'const b = 3;   ', simpleDiff);

      expect(result).toEqual({
        success: true,
        newLine: 2,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
      });
    });
  });
});
