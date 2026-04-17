/**
 * suggest行範囲の重複判定に使用する型
 */
export interface SuggestLineRange {
  filePath: string;
  /** 開始行（newLine - linesAbove） */
  startLine: number;
  /** 終了行（newLine + linesBelow） */
  endLine: number;
}

/**
 * 以前のsuggestの行範囲（discussionIdを含む）
 */
export interface PriorSuggestLineRange extends SuggestLineRange {
  discussionId: string;
}

/**
 * 以前のsuggestと新しいsuggestの行範囲を比較し、
 * 1行でも重複する以前のsuggestのdiscussionIdを返す
 */
export function resolveOverlappingSuggests(
  priorSuggests: PriorSuggestLineRange[],
  newSuggests: SuggestLineRange[],
): string[] {
  if (priorSuggests.length === 0 || newSuggests.length === 0) {
    return [];
  }

  const overlappingIds: string[] = [];

  for (const prior of priorSuggests) {
    const hasOverlap = newSuggests.some(
      (ns) =>
        ns.filePath === prior.filePath &&
        prior.startLine <= ns.endLine &&
        ns.startLine <= prior.endLine,
    );

    if (hasOverlap) {
      overlappingIds.push(prior.discussionId);
    }
  }

  return overlappingIds;
}
