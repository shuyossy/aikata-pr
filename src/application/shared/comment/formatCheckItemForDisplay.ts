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
 * HTMLタグとして解釈されうる山括弧をエスケープする
 * GitLabのMarkdownでは英字の列名（<Category>等）や値（List<String>等）がHTMLタグとして除去されうるため
 */
function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * チェック項目のcontentをdiscussion表示用フォーマットに変換する
 *
 * AI連携用フォーマット（header:\n---\nvalue\n---）を
 * discussion表示用フォーマット（<header>\nvalue）に変換する。
 * 構造化フォーマットでない場合はそのまま返す。
 * いずれの場合も山括弧はエスケープされる。
 */
export function formatCheckItemForDisplay(content: string): string {
  const columns = extractColumns(content);

  // 構造化フォーマットが検出されなかった場合はそのまま返す
  if (columns.length === 0) return escapeAngleBrackets(content);
  return columns
    .map((c) => `${escapeAngleBrackets(`<${c.header}>`)}\n${escapeAngleBrackets(c.value)}\n---`)
    .join('\n');
}

/** Markdownの段落内で改行を保つための行末ハード改行 */
const LINE_BREAK = '<br>';

/**
 * チェック項目のcontentを詳細表示（テーブル外のMarkdown）用フォーマットに変換する
 *
 * 構造化フォーマットの場合は「<header>」行と値の各行を、そうでない場合はテキストの各行を出力する。
 * Markdownでは単独の改行が改行として扱われず、また「値\n---」がsetext見出しになるため、
 * 列末尾の区切り線は出力せず、最終行以外の行末に<br>を付与して改行を保つ。
 * 山括弧はエスケープされる。
 */
export function formatCheckItemForDetail(content: string): string {
  const columns = extractColumns(content);
  const lines =
    columns.length === 0
      ? content.split('\n')
      : columns.flatMap((c) => [`<${c.header}>`, ...c.value.split('\n')]);

  return lines
    .map((line, index) =>
      index < lines.length - 1
        ? `${escapeAngleBrackets(line)}${LINE_BREAK}`
        : escapeAngleBrackets(line),
    )
    .join('\n');
}
