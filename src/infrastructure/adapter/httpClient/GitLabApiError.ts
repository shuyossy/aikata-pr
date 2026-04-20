/**
 * GitLab APIエラーを表すカスタムエラークラス
 * HTTPステータス、レスポンスボディ、リクエスト情報を保持する
 */
export class GitLabApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly responseBody: string;
  readonly method: string;
  readonly path: string;
  readonly requestBody: string | undefined;

  /** エラーメッセージに含めるリクエストボディの最大文字数 */
  private static readonly MAX_REQUEST_BODY_IN_MESSAGE = 2000;

  constructor(params: {
    status: number;
    statusText: string;
    responseBody: string;
    method: string;
    path: string;
    requestBody?: string;
  }) {
    const base = `GitLab API error: ${params.status} ${params.statusText} - ${params.method} ${params.path}\nResponse body: ${params.responseBody}`;
    const reqBody =
      params.requestBody !== undefined
        ? `\nRequest body: ${GitLabApiError.truncateForMessage(params.requestBody)}`
        : '';
    const guidance =
      params.status >= 500
        ? '\nThis may be a temporary server issue. Please wait a few minutes and re-run the job.'
        : '';
    super(`${base}${reqBody}${guidance}`);
    this.name = 'GitLabApiError';
    this.status = params.status;
    this.statusText = params.statusText;
    this.responseBody = params.responseBody;
    this.method = params.method;
    this.path = params.path;
    this.requestBody = params.requestBody;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }

  /**
   * エラーメッセージ用にリクエストボディを截断する
   */
  private static truncateForMessage(body: string): string {
    if (body.length <= GitLabApiError.MAX_REQUEST_BODY_IN_MESSAGE) {
      return body;
    }
    return `${body.substring(0, GitLabApiError.MAX_REQUEST_BODY_IN_MESSAGE)}... [truncated, total ${body.length} chars]`;
  }
}
