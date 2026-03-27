import { Checklist } from '../../../domain/checklist/index.js';
import { CheckItem } from '../../../domain/checkItem/index.js';

/**
 * チェックリストCSVパーサー
 * CSV文字列をチェックリストドメインオブジェクトに変換する
 */
export class ChecklistParser {
  /**
   * CSV文字列からChecklistを生成する
   * 各行が1つのチェック項目に対応する
   * 空行は無視される
   */
  static parse(csv: string): Checklist {
    const lines = csv
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    const items = lines.map((line) => new CheckItem(line));

    return new Checklist(items);
  }
}
