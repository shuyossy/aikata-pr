/**
 * pipeline-report 設定ファイルのパース失敗を表すエラー。
 * JSON 構文エラー・スキーマ不整合・不正な RegExp などをまとめて表現する。
 */
export class PipelineReportSettingsParseError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PipelineReportSettingsParseError';
  }
}
