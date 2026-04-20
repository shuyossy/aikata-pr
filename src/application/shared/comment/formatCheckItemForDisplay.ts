/**
 * チェック項目のcontentをdiscussion表示用フォーマットに変換する
 *
 * AI連携用フォーマット（header:\n---\nvalue\n---）を
 * discussion表示用フォーマット（<header>\nvalue）に変換する。
 * 構造化フォーマットでない場合はそのまま返す。
 *
 * 値の中に\n\nが含まれていても、次列の構造パターン（headerName:\n---\n）が
 * 後続しない限り誤マッチしないlookaheadを使用する。
 */
export function formatCheckItemForDisplay(content: string): string {
  const pattern = /([^\n]+):\n---\n([\s\S]*?)\n---(?=\n\n[^\n]+:\n---\n|$)/g;
  const columns: string[] = [];
  let match;

  while ((match = pattern.exec(content)) !== null) {
    columns.push(`<${match[1]}>\n${match[2]}`);
  }

  // 構造化フォーマットが検出されなかった場合はそのまま返す
  if (columns.length === 0) return content;
  return columns.join('\n');
}
