import { describe, it, expect } from 'vitest';
import { formatCheckItemForDisplay } from '../formatCheckItemForDisplay.js';

describe('formatCheckItemForDisplay', () => {
  describe('構造化フォーマットの変換', () => {
    it('複数列の構造化フォーマットが<header>形式に変換される', () => {
      const content =
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe(
        '<カテゴリ>\nセキュリティ\n---\n<チェック項目>\nSQLインジェクション対策\n---',
      );
    });

    it('単一列の構造化フォーマットが<header>形式に変換される', () => {
      const content = 'チェック項目:\n---\nコード可読性\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('<チェック項目>\nコード可読性\n---');
    });

    it('3列の構造化フォーマットが正しく変換される', () => {
      const content =
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---\n\n説明:\n---\nバインディング確認\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe(
        '<カテゴリ>\nセキュリティ\n---\n<チェック項目>\nSQLインジェクション対策\n---\n<説明>\nバインディング確認\n---',
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

      expect(result).toBe('<ヘッダ1>\n行1\n行2\n---\n<ヘッダ2>\n値2\n---');
    });

    it('値に2連続改行を含む場合も正しく変換される', () => {
      const content = 'ヘッダ1:\n---\n行1\n\n行2\n---\n\nヘッダ2:\n---\n値2\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('<ヘッダ1>\n行1\n\n行2\n---\n<ヘッダ2>\n値2\n---');
    });

    it('空値の場合も正しく変換される', () => {
      const content = 'ヘッダ1:\n---\n\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('<ヘッダ1>\n\n---');
    });

    it('空値を含む複数列の場合も正しく変換される', () => {
      const content = 'ヘッダ1:\n---\n値1\n---\n\nヘッダ2:\n---\n\n---';

      const result = formatCheckItemForDisplay(content);

      expect(result).toBe('<ヘッダ1>\n値1\n---\n<ヘッダ2>\n\n---');
    });
  });
});
