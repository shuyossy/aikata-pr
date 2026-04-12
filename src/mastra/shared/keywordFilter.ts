/**
 * テキストからキーワードにマッチする行と周辺コンテキストを抽出するフィルター
 *
 * getDiffDetailTool / getJobLogDetailTool 共通で利用する
 */

/**
 * デフォルトのコンテキスト行数
 */
const DEFAULT_CONTEXT_LINES = 3;

/**
 * キーワードフィルタリング結果
 */
export interface KeywordFilterResult {
  /** フィルタリング後のテキスト（マッチ0件時は空文字列） */
  filteredText: string;
  /** マッチした行が存在するか */
  hasMatches: boolean;
}

/**
 * テキストからキーワードにマッチする行と周辺コンテキストを抽出する
 *
 * - 大文字小文字を無視したOR検索
 * - マッチ行の前後contextLines行を含める
 * - 非連続範囲間に '...' を挿入
 *
 * @param text フィルタリング対象のテキスト
 * @param keywords 検索キーワード配列（OR検索）
 * @param contextLines マッチ行の前後に含めるコンテキスト行数（デフォルト: 3）
 */
export function filterByKeywords(
  text: string,
  keywords: string[],
  contextLines?: number,
): KeywordFilterResult {
  const lines = text.split('\n');
  const ctx = contextLines ?? DEFAULT_CONTEXT_LINES;
  const matchingIndices = new Set<number>();

  lines.forEach((line, i) => {
    const lowerLine = line.toLowerCase();
    if (keywords.some((kw) => lowerLine.includes(kw.toLowerCase()))) {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        matchingIndices.add(j);
      }
    }
  });

  if (matchingIndices.size === 0) {
    return { filteredText: '', hasMatches: false };
  }

  const sortedIndices = Array.from(matchingIndices).sort((a, b) => a - b);
  const filteredLines: string[] = [];
  let lastIndex = -2;
  for (const idx of sortedIndices) {
    if (idx > lastIndex + 1) {
      filteredLines.push('...');
    }
    filteredLines.push(lines[idx]!);
    lastIndex = idx;
  }

  return { filteredText: filteredLines.join('\n'), hasMatches: true };
}
