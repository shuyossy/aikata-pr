/**
 * チェック項目エンティティ
 * 単一のチェック観点を表す値オブジェクト
 */
export class CheckItem {
  readonly content: string;

  constructor(content: string) {
    if (content.trim() === '') {
      throw new Error('CheckItem content must not be empty');
    }
    this.content = content;
  }

  /**
   * 他のCheckItemと等価かどうかを判定する
   */
  equals(other: CheckItem): boolean {
    return this.content === other.content;
  }
}
