/**
 * AI が生成したパイプライン分析レポート本文を表す値オブジェクト。
 */
export class AnalysisReport {
  private constructor(readonly content: string) {}

  /**
   * 文字列コンテンツから AnalysisReport を生成する。
   */
  static of(content: string): AnalysisReport {
    return new AnalysisReport(content);
  }

  /**
   * コンテンツが空または空白文字のみかを判定する。
   */
  isEmpty(): boolean {
    return this.content.trim().length === 0;
  }
}
