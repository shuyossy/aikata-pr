/**
 * チェックリストCSVパースオプション
 */
export interface ChecklistParseOptions {
  /** 抽出対象の列番号（1始まり）。nullの場合は全列を抽出 */
  columns: number[] | null;
  /** ヘッダを除外するか。最終的に抽出される列が1列の場合のみ有効 */
  noHeader: boolean;
}
