import { describe, it, expect } from 'vitest';
import {
  formatCheckItemForDisplay,
  formatCheckItemForDetail,
} from '../formatCheckItemForDisplay.js';

describe('formatCheckItemForDisplay', () => {
  describe('構造化フォーマットの変換', () => {
    it('複数列の構造化フォーマットが&lt;header&gt;形式に変換される', () => {
      const content =
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe(
        '&lt;カテゴリ&gt;\nセキュリティ\n---\n&lt;チェック項目&gt;\nSQLインジェクション対策\n---',
      );
    });

    it('単一列の構造化フォーマットが&lt;header&gt;形式に変換される', () => {
      const content = 'チェック項目:\n---\nコード可読性\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('&lt;チェック項目&gt;\nコード可読性\n---');
    });

    it('3列の構造化フォーマットが正しく変換される', () => {
      const content =
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---\n\n説明:\n---\nバインディング確認\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe(
        '&lt;カテゴリ&gt;\nセキュリティ\n---\n&lt;チェック項目&gt;\nSQLインジェクション対策\n---\n&lt;説明&gt;\nバインディング確認\n---',
      );
    });
  });

  describe('plain textの場合', () => {
    it('構造化フォーマットでないテキストはそのまま返される', () => {
      const content = 'コード可読性';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('コード可読性');
    });

    it('改行を含むplain textはそのまま返される', () => {
      const content = '項目A\n項目B';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('項目A\n項目B');
    });
  });

  describe('エッジケース', () => {
    it('値に改行を含む場合も正しく変換される', () => {
      const content = 'ヘッダ1:\n---\n行1\n行2\n---\n\nヘッダ2:\n---\n値2\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('&lt;ヘッダ1&gt;\n行1\n行2\n---\n&lt;ヘッダ2&gt;\n値2\n---');
    });

    it('値に2連続改行を含む場合も正しく変換される', () => {
      const content = 'ヘッダ1:\n---\n行1\n\n行2\n---\n\nヘッダ2:\n---\n値2\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('&lt;ヘッダ1&gt;\n行1\n\n行2\n---\n&lt;ヘッダ2&gt;\n値2\n---');
    });

    it('空値の場合も正しく変換される', () => {
      const content = 'ヘッダ1:\n---\n\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('&lt;ヘッダ1&gt;\n\n---');
    });

    it('空値を含む複数列の場合も正しく変換される', () => {
      const content = 'ヘッダ1:\n---\n値1\n---\n\nヘッダ2:\n---\n\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('&lt;ヘッダ1&gt;\n値1\n---\n&lt;ヘッダ2&gt;\n\n---');
    });
  });

  describe('HTMLタグとして解釈されうる文字のエスケープ', () => {
    it('英字の列名がHTMLタグとして解釈されないようエスケープされる', () => {
      const content = 'Category:\n---\nSecurity\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('&lt;Category&gt;\nSecurity\n---');
    });

    it('値に含まれる山括弧もエスケープされる', () => {
      const content = 'チェック項目:\n---\nList<String>を使っているか\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('&lt;チェック項目&gt;\nList&lt;String&gt;を使っているか\n---');
    });

    it('構造化フォーマットでないテキストの山括弧もエスケープされる', () => {
      const result = formatCheckItemForDisplay('Map<K, V>の扱い');

      expect(result).toBe('Map&lt;K, V&gt;の扱い');
    });
  });

  describe('formatCheckItemForDetail', () => {
    it('複数列の構造化フォーマットは列名と値を<br>付きの行で連結する', () => {
      const content =
        'カテゴリ:\n---\n設計\n---\n\nチェック項目:\n---\n命名規則が統一されているか\n---';

      const result = formatCheckItemForDetail(content);

      expect(result).toBe(
        '&lt;カテゴリ&gt;<br>\n設計<br>\n&lt;チェック項目&gt;<br>\n命名規則が統一されているか',
      );
    });

    it('列の末尾の区切り線（---）は出力しない', () => {
      const content = 'チェック項目:\n---\n命名規則\n---';

      const result = formatCheckItemForDetail(content);

      expect(result).toBe('&lt;チェック項目&gt;<br>\n命名規則');
      expect(result).not.toContain('---');
    });

    it('複数行の値は各行に<br>を付けて改行を保つ', () => {
      const content = '説明:\n---\n観点A\n\n観点B\n---';

      const result = formatCheckItemForDetail(content);

      expect(result).toBe('&lt;説明&gt;<br>\n観点A<br>\n<br>\n観点B');
    });

    it('構造化フォーマットでないテキストは各行を<br>で連結する', () => {
      expect(formatCheckItemForDetail('コードの可読性')).toBe('コードの可読性');
      expect(formatCheckItemForDetail('項目A\n項目B')).toBe('項目A<br>\n項目B');
    });

    it('列名・値の山括弧はエスケープされる', () => {
      const content = 'Item:\n---\nList<String>\n---';

      const result = formatCheckItemForDetail(content);

      expect(result).toBe('&lt;Item&gt;<br>\nList&lt;String&gt;');
    });

    it('出力に空行を含まない（Markdownの段落が途切れない）', () => {
      const content = 'ヘッダ1:\n---\n\n---\n\nヘッダ2:\n---\n値2\n---';

      const result = formatCheckItemForDetail(content);

      expect(result.split('\n')).not.toContain('');
    });
  });
});
