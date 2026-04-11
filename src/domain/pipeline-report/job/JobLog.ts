/**
 * ログから省略された範囲（文字オフセット）
 */
export interface OmittedRange {
  startChar: number;
  endChar: number;
}

/**
 * ジョブのログ本文を表現する値オブジェクト。
 * 全文保持（full）と中間圧縮済み（compressed）の 2 種類のファクトリを提供する。
 */
export class JobLog {
  private constructor(
    readonly jobId: number,
    readonly compressedText: string,
    readonly omittedRange: OmittedRange | null,
    readonly totalChars: number,
  ) {}

  /**
   * 圧縮なしの全文ログから JobLog を生成する。
   */
  static full(jobId: number, text: string): JobLog {
    return new JobLog(jobId, text, null, text.length);
  }

  /**
   * 中間省略済みのログから JobLog を生成する。
   * totalChars には元（圧縮前）の全文字数を指定する。
   */
  static compressed(params: {
    jobId: number;
    compressedText: string;
    omittedRange: OmittedRange;
    totalChars: number;
  }): JobLog {
    return new JobLog(params.jobId, params.compressedText, params.omittedRange, params.totalChars);
  }
}
