import { describe, it, expect } from 'vitest';
import { ChecklistParser } from '../ChecklistParser.js';
import type { ChecklistParseOptions } from '../ChecklistParseOptions.js';

/** デフォルトオプション（全列・ヘッダ付き） */
const defaultOptions: ChecklistParseOptions = { columns: null, noHeader: false };

describe('ChecklistParser', () => {
  describe('デフォルト（全列・ヘッダ付き）', () => {
    it('複数列CSVから構造化フォーマットのChecklistを生成できる', () => {
      const csv =
        'カテゴリ,チェック項目,説明\n' +
        'セキュリティ,SQLインジェクション対策,バインディング確認\n' +
        'パフォーマンス,N+1問題,クエリ最適化確認';
      const checklist = ChecklistParser.parse(csv, defaultOptions);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe(
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---\n\n説明:\n---\nバインディング確認\n---',
      );
      expect(checklist.items[1].content).toBe(
        'カテゴリ:\n---\nパフォーマンス\n---\n\nチェック項目:\n---\nN+1問題\n---\n\n説明:\n---\nクエリ最適化確認\n---',
      );
    });

    it('1列のみのCSVでもヘッダ付きフォーマットになる', () => {
      const csv = 'チェック項目\nコード可読性\nテスト網羅性';
      const checklist = ChecklistParser.parse(csv, defaultOptions);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe('チェック項目:\n---\nコード可読性\n---');
      expect(checklist.items[1].content).toBe('チェック項目:\n---\nテスト網羅性\n---');
    });
  });

  describe('列指定（複数列）', () => {
    it('指定列のみ抽出してヘッダ付きフォーマットになる', () => {
      const csv =
        'No,カテゴリ,チェック項目,説明\n' +
        '1,セキュリティ,SQLi対策,バインディング確認\n' +
        '2,パフォーマンス,N+1問題,クエリ最適化';
      const options: ChecklistParseOptions = { columns: [2, 3], noHeader: false };
      const checklist = ChecklistParser.parse(csv, options);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe(
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLi対策\n---',
      );
    });
  });

  describe('列指定（1列）+ ヘッダあり', () => {
    it('1列指定でもヘッダ付きフォーマットになる', () => {
      const csv = 'No,チェック項目,説明\n1,コード可読性,可読性確認\n2,テスト網羅性,カバレッジ確認';
      const options: ChecklistParseOptions = { columns: [2], noHeader: false };
      const checklist = ChecklistParser.parse(csv, options);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe('チェック項目:\n---\nコード可読性\n---');
    });
  });

  describe('列指定（1��）+ noHeader', () => {
    it('生の値がそのままcontentになる', () => {
      const csv = 'No,チェック項目,説明\n1,コード可読性,可読性確認\n2,テスト網羅性,カバレッジ確認';
      const options: ChecklistParseOptions = { columns: [2], noHeader: true };
      const checklist = ChecklistParser.parse(csv, options);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe('コード可読性');
      expect(checklist.items[1].content).toBe('テスト網羅性');
    });
  });

  describe('CSV自体が1列 + noHeader（columns未指定）', () => {
    it('CSVが元々1列の場合もnoHeaderが��効で生の値がそのままcontentになる', () => {
      const csv = 'チェック項目\nコード可読性\nテスト網羅性';
      const options: ChecklistParseOptions = { columns: null, noHeader: true };
      const checklist = ChecklistParser.parse(csv, options);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe('コード可読性');
      expect(checklist.items[1].content).toBe('テスト網羅性');
    });
  });

  describe('noHeader + 複数列 → noHeader無視', () => {
    it('抽出列が複数の場合はnoHeaderが指定されてもヘッダ付きフォーマットになる', () => {
      const csv = 'カテゴリ,チェック項目\nセキュリティ,SQLi対策\nパフォーマンス,N+1問題';
      const options: ChecklistParseOptions = { columns: null, noHeader: true };
      const checklist = ChecklistParser.parse(csv, options);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe(
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLi対策\n---',
      );
    });
  });

  describe('RFC 4180準拠のCSV処理', () => {
    it('カンマを含むクォート付きフィールドを正しくパースできる', () => {
      const csv = 'ヘッダ1,ヘッダ2\n"値1,値1続き",値2';
      const checklist = ChecklistParser.parse(csv, defaultOptions);

      expect(checklist.size).toBe(1);
      expect(checklist.items[0].content).toBe(
        'ヘッダ1:\n---\n値1,値1続き\n---\n\nヘッダ2:\n---\n値2\n---',
      );
    });

    it('フィールド内改行を正しくパースできる', () => {
      const csv = 'ヘッダ1,ヘッダ2\n"行1\n行2",値2';
      const checklist = ChecklistParser.parse(csv, defaultOptions);

      expect(checklist.size).toBe(1);
      expect(checklist.items[0].content).toBe(
        'ヘッダ1:\n---\n行1\n行2\n---\n\nヘッダ2:\n---\n値2\n---',
      );
    });

    it('ダブルクォートのエ��ケープを正しくパースできる', () => {
      const csv = 'ヘッダ1\n"値に""クォート""あり"';
      const checklist = ChecklistParser.parse(csv, defaultOptions);

      expect(checklist.size).toBe(1);
      expect(checklist.items[0].content).toBe('ヘッダ1:\n---\n値に"クォート"あり\n---');
    });
  });

  describe('空セルの処理', () => {
    it('空セルを含む行も正常にパースできる', () => {
      const csv = 'ヘッダ1,ヘッダ2\n値1,\n,値4';
      const checklist = ChecklistParser.parse(csv, defaultOptions);

      expect(checklist.size).toBe(2);
      expect(checklist.items[0].content).toBe('ヘッダ1:\n---\n値1\n---\n\nヘッダ2:\n---\n\n---');
    });
  });

  describe('エラーケース', () => {
    it('空のCSVではエラーになる', () => {
      expect(() => ChecklistParser.parse('', defaultOptions)).toThrow();
    });

    it('ヘッダのみ（データ行なし）ではエラーになる', () => {
      expect(() => ChecklistParser.parse('ヘッダ1,ヘッダ2', defaultOptions)).toThrow();
    });

    it('存在しない列番号を指定するとエラーになる', () => {
      const csv = 'ヘッダ1,ヘッダ2\n値1,値2';
      const options: ChecklistParseOptions = { columns: [5], noHeader: false };
      expect(() => ChecklistParser.parse(csv, options)).toThrow();
    });

    it('列番号0以下を指定するとエラーになる', () => {
      const csv = 'ヘッダ1,ヘッダ2\n値1,値2';
      const options: ChecklistParseOptions = { columns: [0], noHeader: false };
      expect(() => ChecklistParser.parse(csv, options)).toThrow();
    });
  });

  describe('parseDisplayContentMap', () => {
    const csv =
      'No,カテゴリ,チェック項目,説明\n' +
      '1,セキュリティ,SQLi対策,バインディング確認\n' +
      '2,性能,N+1問題,クエリ最適化確認';

    /** AI指示用: No列を除く3列 */
    const aiOptions = { columns: [2, 3, 4], noHeader: false };

    it('AI用contentをキー、表示用contentを値とするマップを返す', () => {
      const checklist = ChecklistParser.parse(csv, aiOptions);
      const map = ChecklistParser.parseDisplayContentMap(csv, aiOptions, {
        columns: [3],
        noHeader: true,
      });

      // キーはparse()が返すitemsのcontentと完全に一致する
      expect([...map.keys()]).toEqual(checklist.items.map((i) => i.content));
      expect(map.get(checklist.items[0]!.content)).toBe('SQLi対策');
      expect(map.get(checklist.items[1]!.content)).toBe('N+1問題');
    });

    it('表示列がAI指示用と同じ場合は値がAI用contentと一致する', () => {
      const checklist = ChecklistParser.parse(csv, aiOptions);
      const map = ChecklistParser.parseDisplayContentMap(csv, aiOptions, aiOptions);

      for (const item of checklist.items) {
        expect(map.get(item.content)).toBe(item.content);
      }
    });

    it('表示列を複数指定した場合はヘッダ付き構造化フォーマットになる', () => {
      const checklist = ChecklistParser.parse(csv, aiOptions);
      const map = ChecklistParser.parseDisplayContentMap(csv, aiOptions, {
        columns: [2, 3],
        noHeader: false,
      });

      expect(map.get(checklist.items[0]!.content)).toBe(
        'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLi対策\n---',
      );
    });

    it('表示列のセルが空でも例外にならず空文字がマップされる（表示専用のため）', () => {
      const csvWithEmpty = 'チェック項目,備考\nコード可読性,';
      const checklist = ChecklistParser.parse(csvWithEmpty, { columns: [1], noHeader: true });
      const map = ChecklistParser.parseDisplayContentMap(
        csvWithEmpty,
        { columns: [1], noHeader: true },
        { columns: [2], noHeader: true },
      );

      expect(map.get(checklist.items[0]!.content)).toBe('');
    });

    it('AI用contentが重複する行は後の行の表示用contentが優先される', () => {
      const duplicatedCsv = 'カテゴリ,チェック項目\n設計,同一項目\n実装,同一項目';
      const map = ChecklistParser.parseDisplayContentMap(
        duplicatedCsv,
        { columns: [2], noHeader: true },
        { columns: [1], noHeader: true },
      );

      expect(map.size).toBe(1);
      expect(map.get('同一項目')).toBe('実装');
    });

    it('AI指示用の不正な列番号を指定した場合はエラーになる', () => {
      expect(() =>
        ChecklistParser.parseDisplayContentMap(csv, { columns: [99], noHeader: false }, aiOptions),
      ).toThrow('Column number 99 exceeds the number of columns (4)');
    });

    it('表示用の不正な列番号を指定した場合はエラーになる', () => {
      expect(() =>
        ChecklistParser.parseDisplayContentMap(csv, aiOptions, { columns: [99], noHeader: false }),
      ).toThrow('Column number 99 exceeds the number of columns (4)');
    });
  });
});
