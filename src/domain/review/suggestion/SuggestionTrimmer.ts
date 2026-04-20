/**
 * トリミング結果の型
 */
export interface SuggestionTrimResult {
  /** トリミング後のoriginalCode */
  trimmedOriginalCode: string;
  /** トリミング後のsuggestedCode */
  trimmedSuggestedCode: string;
  /** 先頭から除去した共通行数 */
  leadingTrimmedCount: number;
}

/**
 * originalCodeとsuggestedCodeの共通先頭行・共通末尾行を除去する
 * 行番号解決後に呼び出し、GitLabのsuggestion範囲を最小化する
 *
 * トリミング不要な場合（共通行がない、全行同一など）はnullを返す
 */
export function trimCommonLines(
  originalCode: string,
  suggestedCode: string,
): SuggestionTrimResult | null {
  const originalLines = originalCode.split('\n');
  const suggestedLines = suggestedCode.split('\n');

  // 先頭からの共通行数をカウント
  const maxLeading = Math.min(originalLines.length, suggestedLines.length);
  let leadingCommon = 0;
  while (
    leadingCommon < maxLeading &&
    originalLines[leadingCommon] === suggestedLines[leadingCommon]
  ) {
    leadingCommon++;
  }

  // 末尾からの共通行数をカウント（先頭と重複しない範囲で）
  const maxTrailing = Math.min(
    originalLines.length - leadingCommon,
    suggestedLines.length - leadingCommon,
  );
  let trailingCommon = 0;
  while (
    trailingCommon < maxTrailing &&
    originalLines[originalLines.length - 1 - trailingCommon] ===
      suggestedLines[suggestedLines.length - 1 - trailingCommon]
  ) {
    trailingCommon++;
  }

  // 共通行がない場合はトリミング不要
  if (leadingCommon === 0 && trailingCommon === 0) {
    return null;
  }

  const trimmedOriginalLines = originalLines.slice(
    leadingCommon,
    originalLines.length - trailingCommon,
  );
  const trimmedSuggestedLines = suggestedLines.slice(
    leadingCommon,
    suggestedLines.length - trailingCommon,
  );

  // トリミング後のoriginalCodeが空の場合（全行同一）はトリミングしない
  if (trimmedOriginalLines.length === 0) {
    return null;
  }

  return {
    trimmedOriginalCode: trimmedOriginalLines.join('\n'),
    trimmedSuggestedCode: trimmedSuggestedLines.join('\n'),
    leadingTrimmedCount: leadingCommon,
  };
}
