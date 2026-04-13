/**
 * pipeline-report APIリクエストの型
 *
 * APIサーバーのpipelineReportRequestSchemaに合わせる。
 * includeJobPatterns / excludeJobPatterns は RegExp の source 文字列配列として渡す。
 */
export interface PipelineReportApiRequest {
  /** 本テンプレートを実行したユーザID（通常は$GITLAB_USER_LOGIN）。APIサーバー側でログに記録される */
  userId: string;
  /** GitLab APIトークン（APIサーバーがGitLab APIアクセス・リポジトリクローンに使用） */
  gitlabToken: string;
  projectId: number;
  pipelineId: number;
  /** レポート出力ジョブ自身のID。null なら自己除外無し */
  selfJobId: number | null;
  settings: {
    jobReportFormat: string;
    additionalInstructions: string | null;
    /** RegExp の source 文字列配列 */
    includeJobPatterns: string[];
    /** RegExp の source 文字列配列 */
    excludeJobPatterns: string[];
  };
  commentLanguage: string;
  maxCompletenessRetries: number;
  skillsRelPaths: string[];
  /** フォルダツリー走査の最大深度。undefined なら無制限 */
  treeMaxDepth: number | undefined;
}

/**
 * pipeline-report APIレスポンス（resultイベントのペイロード）
 */
export interface PipelineReportApiResult {
  /** レポート本文（markdown） */
  reportContent: string;
  /** 完成判定フラグ */
  completenessVerified: boolean;
  /** 完成判定リトライ回数 */
  completenessRetries: number;
  /** workflow が失敗したが部分レポートを回復した場合に true */
  workflowFailed: boolean;
  /** 分析対象となったジョブIDの一覧 */
  targetJobIds: number[];
  /** パイプライン情報 */
  pipeline: {
    projectId: number;
    pipelineId: number;
    ref: string;
    sha: string;
    status: string;
    webUrl: string;
  };
}

/**
 * pipeline-report APIの進捗イベント
 *
 * APIサーバー側は以下の形式でSSEを送出する:
 * - 固定フェーズ: `{ status: 'started' | 'fetching_pipeline' | 'cloning' | 'analyzing' }`
 * - ワークフロー内の詳細進捗: `{ status: 'workflow', workflow: <PipelineAnalysisProgressEvent> }`
 *
 * 本クライアントは両者を区別せず、そのまま呼び出し元にコールバックで流す。
 */
export interface PipelineReportProgressEvent {
  status: string;
  message?: string;
  /** workflow フェーズの場合に含まれるMastra Workflow進捗 */
  workflow?:
    | { type: 'phase'; phase: string }
    | { type: 'log'; level: string; message: string }
    | { type: 'retry'; reason: string; retryCount: number };
}

/** APIサーバーがレスポンスヘッダで返すリクエストID用ヘッダ名 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * PipelineReportApiClient のハンドラ定義。
 *
 * AGENTS.md「関数の引数は特別な理由がない限りオプショナルは避けること」に従い
 * 全コールバックを必須化する。onRequestId はサーバ側ログとの相関キーを受け取る。
 */
export interface PipelineReportApiClientHandlers {
  /** 進捗イベントを受け取るコールバック */
  onProgress: (event: PipelineReportProgressEvent) => void;
  /**
   * APIサーバーが返した `X-Request-Id` ヘッダを受け取るコールバック。
   * ストリーム消費開始前に同期的に呼び出される。
   * （エラー応答でもヘッダにrequestIdが含まれれば呼ばれる）
   */
  onRequestId: (requestId: string) => void;
  /**
   * SSEストリーム中にerrorイベントを受信した時点で呼ばれるコールバック。
   * このコールバックが呼ばれた後、本メソッドはErrorをthrowするため、
   * 呼び出し側は通知のみに利用する想定。
   */
  onError: (error: Error) => void;
}

/**
 * PipelineReportApiClientの設定
 */
export interface PipelineReportApiClientConfig {
  /** APIサーバーのベースURL（例: `https://aikata-api.example.com`） */
  baseUrl: string;
  /** JWTトークン。null の場合は Authorization ヘッダを付与しない（dev/debug用） */
  jwt: string | null;
}

/**
 * CLI→APIサーバー間のpipeline-report用SSEクライアント。
 *
 * Node.js組み込みのfetchを使用してAPIサーバーの `/api/v1/pipeline-report` を呼び出し、
 * SSEレスポンスストリームをパースして最終的なレポート結果を返す。
 *
 * 仕様:
 * - `progress` イベント → handlers.onProgress にそのまま転送
 * - `result` イベント → Promise を resolve（返値の元ネタ）
 * - `error` イベント → handlers.onError に通知しつつ Error を throw
 * - `keepalive` / `done` イベントは無視
 */
export class PipelineReportApiClient {
  private readonly baseUrl: string;
  private readonly jwt: string | null;

  constructor(config: PipelineReportApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.jwt = config.jwt;
  }

  /**
   * pipeline-report APIを呼び出し、SSEレスポンスを処理する。
   *
   * @param request - pipeline-reportリクエスト
   * @param handlers - 進捗・エラー・requestId 受信コールバック（全て必須）
   * @returns 最終的な `result` イベントのペイロード
   */
  async run(
    request: PipelineReportApiRequest,
    handlers: PipelineReportApiClientHandlers,
  ): Promise<PipelineReportApiResult> {
    const url = `${this.baseUrl}/api/v1/pipeline-report`;

    // jwt が null の場合は Authorization ヘッダを付与しない
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.jwt !== null) {
      headers['Authorization'] = `Bearer ${this.jwt}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    // X-Request-Idヘッダの抽出（エラー応答でも付与される想定のため、!response.okより先に取得）
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    if (requestId) {
      handlers.onRequestId(requestId);
    }

    // 非SSEエラー（400, 401, 500等）
    if (!response.ok) {
      const body = await response.text();
      const err = new Error(
        `Pipeline report API request failed with status ${response.status}: ${body}`,
      );
      handlers.onError(err);
      throw err;
    }

    if (!response.body) {
      const err = new Error('Response body is empty');
      handlers.onError(err);
      throw err;
    }

    // SSEストリームをパース
    return this.parseSSEStream(response.body, handlers);
  }

  /**
   * SSEストリームをパースしてpipeline-report結果を返す
   */
  private async parseSSEStream(
    body: ReadableStream<Uint8Array>,
    handlers: PipelineReportApiClientHandlers,
  ): Promise<PipelineReportApiResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最後の不完全な行をバッファに保持
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6);
        } else if (line === '') {
          // 空行 = イベント区切り
          if (currentEvent && currentData) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(currentData) as Record<string, unknown>;
            } catch {
              const err = new Error(
                `Failed to parse SSE event data for event "${currentEvent}": ${currentData}`,
              );
              handlers.onError(err);
              throw err;
            }

            switch (currentEvent) {
              case 'progress':
                handlers.onProgress(parsed as unknown as PipelineReportProgressEvent);
                break;
              case 'result':
                return parsed as unknown as PipelineReportApiResult;
              case 'error': {
                const message = (parsed['error'] as string) ?? 'Unknown error';
                const err = new Error(`Pipeline report API error: ${message}`);
                handlers.onError(err);
                throw err;
              }
              case 'keepalive':
              case 'done':
                // 無視
                break;
            }
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }

    const err = new Error('SSE stream ended without result event');
    handlers.onError(err);
    throw err;
  }
}
