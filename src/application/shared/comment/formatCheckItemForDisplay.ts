/** 構造化フォーマット（header:\n---\nvalue\n---）の1列分 */
interface CheckItemColumn {
  header: string;
  value: string;
}

/**
 * AI連携用フォーマット（header:\n---\nvalue\n---）から列情報を抽出する
 *
 * 値の中に\n\nが含まれていても、次列の構造パターン（headerName:\n---\n）が
 * 後続しない限り誤マッチしないlookaheadを使用する。
 * 構造化フォーマットでない場合は空配列を返す。
 */
function extractColumns(content: string): CheckItemColumn[] {
  const pattern = /([^\n]+):\n---\n([\s\S]*?)\n---(?=\n\n[^\n]+:\n---\n|$)/g;
  const columns: CheckItemColumn[] = [];
  let match;

  while ((match = pattern.exec(content)) !== null) {
    columns.push({ header: match[1]!, value: match[2]! });
  }

  return columns;
}

/**
 * チェック項目のcontentをdiscussion表示用フォーマットに変換する
 *
 * AI連携用フォーマット（header:\n---\nvalue\n---）を
 * discussion表示用フォーマット（<header>\nvalue）に変換する。
 * 構造化フォーマットでない場合はそのまま返す。
 */
export function formatCheckItemForDisplay(content: string): string {
  const columns = extractColumns(content);

  // 構造化フォーマットが検出されなかった場合はそのまま返す
  if (columns.length === 0) return content;
  return columns.map((c) => `<${c.header}>\n${c.value}\n---`).join('\n');
}

/** 見出し用に列の値を連結する際の区切り文字 */
const HEADING_SEPARATOR = ' / ';

/**
 * チェック項目のcontentをMarkdown見出し用の1行テキストに変換する
 *
 * Markdownの見出しは複数行にできないため、各列の値のみを区切り文字で連結して1行にする。
 * 構造化フォーマットでない場合は改行を区切り文字に置換して1行にする。
 */
export function formatCheckItemForHeading(content: string): string {
  const columns = extractColumns(content);

  if (columns.length === 0) {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(HEADING_SEPARATOR);
  }

  return columns
    .map((c) => c.value.trim())
    .filter((value) => value !== '')
    .join(HEADING_SEPARATOR);
}
