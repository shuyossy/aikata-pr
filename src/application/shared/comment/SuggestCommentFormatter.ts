import { ResolvedSuggestion } from '../../../domain/review/suggestion/index.js';

/** AIKATA-PRのsuggestコメント識別用マーカー */
export const SUGGEST_MARKER = '<!-- aikata-suggest -->';

/** suggestメタデータのプレフィックス */
export const SUGGEST_DATA_PREFIX = '<!-- aikata-suggest-data: ';

/** suggestメタデータのサフィックス */
export const SUGGEST_DATA_SUFFIX = ' -->';

/**
 * ResolvedSuggestionからGitLab diff discussion投稿用のコメント本文を生成するフォーマッター
 */
export class SuggestCommentFormatter {
  /**
   * ResolvedSuggestionをGitLab diff discussion用のMarkdown文字列にフォーマットする
   */
  static format(resolved: ResolvedSuggestion): string {
    const marker = SUGGEST_MARKER;
    const metadata = `${SUGGEST_DATA_PREFIX}${JSON.stringify({
      checkItemContent: resolved.suggestion.checkItemContent,
      filePath: resolved.suggestion.filePath,
      originalCode: resolved.suggestion.originalCode,
      suggestedCode: resolved.suggestion.suggestedCode,
      comment: resolved.suggestion.comment,
    })}${SUGGEST_DATA_SUFFIX}`;

    const header = `**チェック項目:** ${resolved.suggestion.checkItemContent}`;
    const comment = resolved.suggestion.comment;
    const suggestion =
      '```suggestion:-' +
      resolved.linesAbove +
      '+' +
      resolved.linesBelow +
      '\n' +
      resolved.suggestion.suggestedCode +
      '\n' +
      '```';

    return [marker, metadata, header, '', comment, '', suggestion].join('\n');
  }
}
