/**
 * チェックリストファイルの形式
 * - csv: CSV（RFC 4180準拠、先頭行をヘッダとする）
 * - markdown: Markdownテーブル（GFM形式、ファイル内に1つのテーブル）
 */
export type ChecklistFormat = 'csv' | 'markdown';
