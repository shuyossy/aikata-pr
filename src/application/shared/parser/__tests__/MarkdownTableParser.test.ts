import { describe, it, expect } from 'vitest';
import { parseMarkdownTable } from '../MarkdownTableParser.js';

describe('parseMarkdownTable', () => {
  describe('基本的なテーブル', () => {
    it('ヘッダ行とデータ行を2次元配列で返す（区切り行は含まない）', () => {
      const md =
        '| カテゴリ | チェック項目 |\n' +
        '| --- | --- |\n' +
        '| セキュリティ | SQLi対策 |\n' +
        '| パフォーマンス | N+1問題 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['カテゴリ', 'チェック項目'],
        ['セキュリティ', 'SQLi対策'],
        ['パフォーマンス', 'N+1問題'],
      ]);
    });

    it('セルの前後の空白（全角スペース・タブ含む）を除去する', () => {
      const md = '|   A\t|  B  |\n|---|---|\n|\u3000値1\u3000|   値 2   |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['値1', '値 2'],
      ]);
    });

    it('行の前後の空白（3スペースまでのインデント）を無視する', () => {
      const md = '   | A | B |   \n  |---|---|\n | 1 | 2 |  ';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['1', '2'],
      ]);
    });

    it('先頭・末尾のパイプが無い行も解釈できる', () => {
      const md = 'A | B\n--- | ---\n1 | 2\n| 3 | 4 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('1列のテーブルを解釈できる', () => {
      const md = '| チェック項目 |\n| --- |\n| 可読性 |\n| テスト |';

      expect(parseMarkdownTable(md)).toEqual([['チェック項目'], ['可読性'], ['テスト']]);
    });

    it('アライメント指定付きの区切り行を解釈できる', () => {
      const md = '| A | B | C | D |\n|:---|---:|:-:|-|\n| 1 | 2 | 3 | 4 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B', 'C', 'D'],
        ['1', '2', '3', '4'],
      ]);
    });

    it('区切り行のセル内の空白を許容する', () => {
      const md = '| A | B |\n|  :---  |  ---:  |\n| 1 | 2 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['1', '2'],
      ]);
    });
  });

  describe('セル内容の扱い', () => {
    it('エスケープされたパイプ（\\|）はセル区切りではなくリテラルの|として扱う', () => {
      const md = '| A | B |\n|---|---|\n| a \\| b | `x \\|\\| y` |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['a | b', '`x || y`'],
      ]);
    });

    it('パイプ以外のバックスラッシュエスケープはそのまま保持する', () => {
      const md = '| A |\n|---|\n| \\*強調しない\\* |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['\\*強調しない\\*']]);
    });

    it('セル内の<br>系タグ（大文字小文字・自己終了形式を問わない）を改行に変換する', () => {
      const md = '| A |\n|---|\n| 1行目<br>2行目<BR/>3行目<br />4行目 |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1行目\n2行目\n3行目\n4行目']]);
    });

    it('<br>前後の空白は除去する', () => {
      const md = '| A |\n|---|\n| 1行目 <br> 2行目 |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1行目\n2行目']]);
    });

    it('インライン書式（太字・コード等）はそのまま保持する', () => {
      const md = '| A |\n|---|\n| **重要** `code` [link](https://example.com) |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A'],
        ['**重要** `code` [link](https://example.com)'],
      ]);
    });

    it('セル数がヘッダより少ない行は空文字で補完する', () => {
      const md = '| A | B | C |\n|---|---|---|\n| 1 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B', 'C'],
        ['1', '', ''],
      ]);
    });

    it('セル数がヘッダより多い行は超過分を無視する', () => {
      const md = '| A | B |\n|---|---|\n| 1 | 2 | 3 | 4 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['1', '2'],
      ]);
    });

    it('空セルは空文字になる', () => {
      const md = '| A | B |\n|---|---|\n| | 2 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['', '2'],
      ]);
    });

    it('全セルが空のデータ行はスキップする', () => {
      const md = '| A | B |\n|---|---|\n| 1 | 2 |\n|   |   |\n| 3 | 4 |';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('データ行が無いテーブルはヘッダ行のみを返す', () => {
      const md = '| A | B |\n|---|---|';

      expect(parseMarkdownTable(md)).toEqual([['A', 'B']]);
    });
  });

  describe('テーブル外の内容', () => {
    it('テーブル前後の見出し・本文・リストを無視する', () => {
      const md =
        '# チェックリスト\n\n' +
        '説明文です。| を含む文章でも区切り行が続かなければ無視される\n\n' +
        '| A | B |\n|---|---|\n| 1 | 2 |\n\n' +
        '## 補足\n- 箇条書き\n';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['1', '2'],
      ]);
    });

    it('テーブルは空行で終了する', () => {
      const md = '| A |\n|---|\n| 1 |\n\n| 2 |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1']]);
    });

    it('テーブルはパイプを含まない行で終了する', () => {
      const md = '| A |\n|---|\n| 1 |\n終了後の段落';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1']]);
    });

    it('フェンスドコードブロック（``` / ~~~）内のテーブルは無視する', () => {
      const md =
        '```markdown\n| X | Y |\n|---|---|\n| x | y |\n```\n\n' +
        '~~~\n| P |\n|---|\n| p |\n~~~\n\n' +
        '| A |\n|---|\n| 1 |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1']]);
    });

    it('閉じられていないフェンスドコードブロック以降は無視する', () => {
      const md = '| A |\n|---|\n| 1 |\n\n```\n| X |\n|---|\n| x |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1']]);
    });

    it('4スペース以上インデントされた行（インデントコードブロック）はテーブルとみなさない', () => {
      const md = '    | X |\n    |---|\n    | x |\n\n| A |\n|---|\n| 1 |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1']]);
    });

    it('CRLF改行を解釈できる', () => {
      const md = '| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n';

      expect(parseMarkdownTable(md)).toEqual([
        ['A', 'B'],
        ['1', '2'],
      ]);
    });

    it('先頭のBOMを除去する', () => {
      const md = '\uFEFF| A |\n|---|\n| 1 |';

      expect(parseMarkdownTable(md)).toEqual([['A'], ['1']]);
    });
  });

  describe('エラーケース', () => {
    it('空文字ではエラーになる', () => {
      expect(() => parseMarkdownTable('')).toThrow('Markdown checklist must not be empty');
    });

    it('空白のみではエラーになる', () => {
      expect(() => parseMarkdownTable('  \n\t\n')).toThrow('Markdown checklist must not be empty');
    });

    it('テーブルが無い場合はエラーになる', () => {
      expect(() => parseMarkdownTable('# 見出し\n- 箇条書き')).toThrow(
        'Markdown checklist must contain a table (header row and delimiter row)',
      );
    });

    it('区切り行が無い場合はテーブルとみなさずエラーになる', () => {
      expect(() => parseMarkdownTable('| A | B |\n| 1 | 2 |')).toThrow(
        'Markdown checklist must contain a table (header row and delimiter row)',
      );
    });

    it('区切り行のセル数がヘッダと一致しない場合はテーブルとみなさずエラーになる', () => {
      expect(() => parseMarkdownTable('| A | B |\n|---|\n| 1 | 2 |')).toThrow(
        'Markdown checklist must contain a table (header row and delimiter row)',
      );
    });

    it('区切り行に不正な文字が含まれる場合はテーブルとみなさずエラーになる', () => {
      expect(() => parseMarkdownTable('| A | B |\n|---|-x-|\n| 1 | 2 |')).toThrow(
        'Markdown checklist must contain a table (header row and delimiter row)',
      );
    });

    it('テーブルが複数ある場合はエラーになる', () => {
      const md = '| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |';

      expect(() => parseMarkdownTable(md)).toThrow(
        'Markdown checklist must contain exactly one table, found 2',
      );
    });
  });
});
