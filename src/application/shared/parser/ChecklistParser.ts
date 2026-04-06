import { parse } from 'csv-parse/sync';
import { Checklist } from '../../../domain/checklist/index.js';
import { CheckItem } from '../../../domain/checkItem/index.js';
import type { ChecklistParseOptions } from './ChecklistParseOptions.js';

/**
 * チェックリストCSVパーサー
 * CSV文字列をチェックリストドメインオブジェクトに変換する
 */
export class ChecklistParser {
  /**
   * CSV文字���からChecklistを生成する
   *
   * CSVの先頭行をヘッダとして扱い、各データ行を1つのチェック項目に変換する。
   * デフォルトでは全列をヘッダ付きフォーマットで出力する。
   */
  static parse(csv: string, options: ChecklistParseOptions): Checklist {
    if (csv.trim() === '') {
      throw new Error('CSV content must not be empty');
    }

    // RFC 4180準拠のCSVパース
    const records: string[][] = parse(csv, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    if (records.length < 2) {
      throw new Error('CSV must contain at least a header row and one data row');
    }

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

    // 各データ行をチェック項目にフォーマット
    const items = dataRows.map((row) => {
      const content = useNoHeader
        ? (row[columnIndices[0]!] ?? '')
        : selectedHeaders
            .map((header, i) => {
              const value = row[columnIndices[i]!] ?? '';
              return `${header}:\n---\n${value}\n---`;
            })
            .join('\n\n');

      return new CheckItem(content);
    });

    return new Checklist(items);
  }
}
