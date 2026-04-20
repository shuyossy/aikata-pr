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

  constructor(params: {
    status: number;
    statusText: string;
    responseBody: string;
    method: string;
    path: string;
    requestBody?: string;
  }) {
    const base = `GitLab API error: ${params.status} ${params.statusText} - ${params.method} ${params.path}\nResponse body: ${params.responseBody}`;
    const reqBody = params.requestBody !== undefined ? `\nRequest body: ${params.requestBody}` : '';
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
}
