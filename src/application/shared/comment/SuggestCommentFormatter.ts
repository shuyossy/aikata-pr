import { ResolvedSuggestion } from '../../../domain/review/suggestion/index.js';
import { formatCheckItemForDisplay } from './formatCheckItemForDisplay.js';

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
   *
   * checkItemDisplayContentsはAI用content -> 表示用contentのマップ。
   * 未登録のcontentはAI用contentをそのまま表示に用いる。
   */
  static format(
    resolved: ResolvedSuggestion,
    checkItemDisplayContents: ReadonlyMap<string, string>,
  ): string {
    const marker = SUGGEST_MARKER;
    const metadata = `${SUGGEST_DATA_PREFIX}${JSON.stringify({
      checkItemContent: resolved.suggestion.checkItemContent,
    })}${SUGGEST_DATA_SUFFIX}`;

    // メタデータのcheckItemContentは突合キーのためAI用contentのまま、表示のみ表示用contentを使う
    const displayContent = formatCheckItemForDisplay(
      checkItemDisplayContents.get(resolved.suggestion.checkItemContent) ??
        resolved.suggestion.checkItemContent,
    );
    const escapedDisplayContent = displayContent.replace(/\n/g, '<br>');
    const header = `**チェック項目:**<br>${escapedDisplayContent}`;
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
