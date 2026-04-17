/**
 * 変更提案の値オブジェクト
 * チェック項目に紐づくコード修正提案を表す
 */
export interface SuggestionParams {
  /** チェック項目の内容（ドメイン識別子） */
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

export class Suggestion {
  readonly checkItemContent: string;
  readonly filePath: string;
  readonly originalCode: string;
  readonly suggestedCode: string;
  readonly comment: string;

  constructor(params: SuggestionParams) {
    if (params.checkItemContent.trim() === '') {
      throw new Error('checkItemContent must not be empty');
    }
    if (params.filePath.trim() === '') {
      throw new Error('filePath must not be empty');
    }
    if (params.originalCode.trim() === '') {
      throw new Error('originalCode must not be empty');
    }
    if (params.suggestedCode.trim() === '') {
      throw new Error('suggestedCode must not be empty');
    }
    if (params.comment.trim() === '') {
      throw new Error('comment must not be empty');
    }

    this.checkItemContent = params.checkItemContent;
    this.filePath = params.filePath;
    this.originalCode = params.originalCode;
    this.suggestedCode = params.suggestedCode;
    this.comment = params.comment;
  }

  equals(other: Suggestion): boolean {
    return (
      this.checkItemContent === other.checkItemContent &&
      this.filePath === other.filePath &&
      this.originalCode === other.originalCode &&
      this.suggestedCode === other.suggestedCode &&
      this.comment === other.comment
    );
  }
}
