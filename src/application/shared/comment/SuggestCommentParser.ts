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
  /** 対象ファイルパス */
  filePath: string;
  /** 置換対象コード（diffの新しい側） */
  originalCode: string;
  /** 提案コード */
  suggestedCode: string;
  /** suggestに添えるコメント */
  comment: string;
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
      if (!data.checkItemContent || !data.filePath || !data.suggestedCode) {
        return null;
      }
      return {
        checkItemContent: data.checkItemContent,
        filePath: data.filePath,
        originalCode: data.originalCode ?? '',
        suggestedCode: data.suggestedCode,
        comment: data.comment ?? '',
      };
    } catch {
      return null;
    }
  }
}
