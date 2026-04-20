import {
  SUGGEST_MARKER,
  SUGGEST_DATA_PREFIX,
  SUGGEST_DATA_SUFFIX,
} from './SuggestCommentFormatter.js';

/**
 * suggestコメントのパース結果
 */
export interface ParsedSuggestComment {
  /** チェック項目の内容 */
  checkItemContent: string;
}

/**
 * suggestion構文のパース結果
 */
export interface SuggestionRange {
  /** suggestion:-X の値 */
  linesAbove: number;
  /** suggestion:+Y の値 */
  linesBelow: number;
}

/**
 * suggestディスカッション本文からメタデータを抽出するパーサー
 * SuggestCommentFormatterが生成したコメント本文を解析する
 */
export class SuggestCommentParser {
  /**
   * コメント本文がAIKATA-PRのsuggestコメントかどうか判定する
   */
  static isSuggestComment(body: string): boolean {
    return body.includes(SUGGEST_MARKER);
  }

  /**
   * コメント本文からsuggestメタデータを抽出する
   * suggestコメントでない場合やパースに失敗した場合はnullを返す
   */
  static parse(body: string): ParsedSuggestComment | null {
    if (!this.isSuggestComment(body)) {
      return null;
    }

    const dataStart = body.indexOf(SUGGEST_DATA_PREFIX);
    const dataEnd = body.indexOf(SUGGEST_DATA_SUFFIX, dataStart + SUGGEST_DATA_PREFIX.length);
    if (dataStart === -1 || dataEnd === -1) {
      return null;
    }

    try {
      const jsonStr = body.substring(dataStart + SUGGEST_DATA_PREFIX.length, dataEnd);
      const data = JSON.parse(jsonStr);
      // 必須フィールドの存在チェック
      if (!data.checkItemContent) {
        return null;
      }
      return {
        checkItemContent: data.checkItemContent,
      };
    } catch {
      return null;
    }
  }

  /**
   * コメント本文からsuggestion構文（```suggestion:-X+Y）のlinesAbove/linesBelowを抽出する
   * 構文が見つからない場合はnullを返す
   */
  static parseSuggestionRange(body: string): SuggestionRange | null {
    const match = body.match(/```suggestion:-(\d+)\+(\d+)/);
    if (!match) {
      return null;
    }
    return {
      linesAbove: parseInt(match[1], 10),
      linesBelow: parseInt(match[2], 10),
    };
  }
}
