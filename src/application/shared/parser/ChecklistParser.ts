import { parse } from 'csv-parse/sync';
import { Checklist } from '../../../domain/review/checklist/index.js';
import { CheckItem } from '../../../domain/review/checkItem/index.js';
import type { ChecklistFormat } from './ChecklistFormat.js';
import type { ChecklistParseOptions } from './ChecklistParseOptions.js';
import { parseMarkdownTable } from './MarkdownTableParser.js';

/**
 * チェックリストパーサー
 * CSVまたはMarkdownテーブルの文字列をチェックリストドメインオブジェクトに変換する
 */
export class ChecklistParser {
  /**
   * チェックリスト文字列からChecklistを生成する
   *
   * 先頭行をヘッダとして扱い、各データ行を1つのチェック項目に変換する。
   * デフォルトでは全列をヘッダ付きフォーマットで出力する。
   */
  static parse(text: string, format: ChecklistFormat, options: ChecklistParseOptions): Checklist {
    const items = ChecklistParser.buildContents(text, format, options).map(
      (content) => new CheckItem(content),
    );
    return new Checklist(items);
  }

  /**
   * AI指示用content -> レビュー結果コメント表示用content のマップを生成する
   *
   * 同一チェックリストの同一データ行をそれぞれのオプションで走査するため、両者のインデックスは一致する。
   * 表示用contentはCheckItemを経由しないため空セルでも例外にならない（表示専用のため）。
   * AI指示用contentが重複する行がある場合は後の行の表示用contentが優先される。
   */
  static parseDisplayContentMap(
    text: string,
    format: ChecklistFormat,
    options: ChecklistParseOptions,
    displayOptions: ChecklistParseOptions,
  ): Map<string, string> {
    const contents = ChecklistParser.buildContents(text, format, options);
    const displayContents = ChecklistParser.buildContents(text, format, displayOptions);

    return new Map(contents.map((content, i) => [content, displayContents[i] ?? content]));
  }

  /**
   * チェックリスト文字列を形式に応じて解析し、ヘッダ行 + データ行のレコードを返す
   */
  private static readRecords(text: string, format: ChecklistFormat): string[][] {
    if (format === 'markdown') {
      const records = parseMarkdownTable(text);
      if (records.length < 2) {
        throw new Error(
          'Markdown checklist table must contain at least a header row and one data row',
        );
      }
      return records;
    }

    if (text.trim() === '') {
      throw new Error('CSV content must not be empty');
    }

    // RFC 4180準拠のCSVパース
    const records: string[][] = parse(text, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    if (records.length < 2) {
      throw new Error('CSV must contain at least a header row and one data row');
    }
    return records;
  }

  /**
   * チェックリスト文字列を解析し、データ行ごとのチェック項目テキストを生成する
   */
  private static buildContents(
    text: string,
    format: ChecklistFormat,
    options: ChecklistParseOptions,
  ): string[] {
    const records = ChecklistParser.readRecords(text, format);
    const headers = records[0]!;
    const dataRows = records.slice(1);

    // 列番号バリデーションとインデックス解決
    let columnIndices: number[];
    let selectedHeaders: string[];

    if (options.columns !== null) {
      // 列番号のバリデーション
      for (const col of options.columns) {
        if (col < 1) {
          throw new Error(`Column number must be >= 1, got: ${col}`);
        }
        if (col > headers.length) {
          throw new Error(`Column number ${col} exceeds the number of columns (${headers.length})`);
        }
      }
      columnIndices = options.columns.map((col) => col - 1);
      selectedHeaders = columnIndices.map((i) => headers[i]!);
    } else {
      columnIndices = headers.map((_, i) => i);
      selectedHeaders = [...headers];
    }

    // noHeaderが有効かどうか判定（抽出列が1列の場合のみ）
    const useNoHeader = options.noHeader && selectedHeaders.length === 1;

    // 各データ行をチェック項目のテキストにフォーマット
    return dataRows.map((row) =>
      useNoHeader
        ? (row[columnIndices[0]!] ?? '')
        : selectedHeaders
            .map((header, i) => {
              const value = row[columnIndices[i]!] ?? '';
              return `${header}:\n---\n${value}\n---`;
            })
            .join('\n\n'),
    );
  }
}
