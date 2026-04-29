import { randomUUID } from 'node:crypto';
import {
  fetchWithRetry,
  pollJobResult,
  DEFAULT_FETCH_RETRY,
  DEFAULT_POLL_OPTIONS,
} from '../../httpClient/jobResultPolling.js';
import type { FetchRetryOptions } from '../../httpClient/jobResultPolling.js';

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
    analysisInstructions: string | null;
    reportRefinementInstructions: string | null;
    /** RegExp の source 文字列配列 */
    includeJobPatterns: string[];
    /** RegExp の source 文字列配列 */
    excludeJobPatterns: string[];
  };
  commentLanguage: string;
  maxCompletenessRetries: number;
  skipCompletenessCheck: boolean;
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
 * - Idempotency-Key検知: `{ status: 'duplicated', existingJobId: string }`
 *
 * 本クライアントは duplicated を内部処理（フォールバックポーリング起動）し、
 * その他は呼び出し元にコールバックで流す。
 */
export interface PipelineReportProgressEvent {
  status: string;
  message?: string;
  /** Idempotency-Key一致で既存ジョブが見つかった時に existingJobId を含む */
  existingJobId?: string;
  /** workflow フェーズの場合に含まれるMastra Workflow進捗 */
  workflow?:
    | { type: 'phase'; phase: string }
    | { type: 'log'; level: string; message: string }
    | { type: 'retry'; reason: string; retryCount: number };
}

/** APIサーバーがレスポンスヘッダで返すリクエストID用ヘッダ名 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** CLI→APIサーバ間のバージョン伝達に使用するHTTPヘッダ名 */
export const VERSION_HEADER = 'X-Aikata-Version';

/** クライアント生成のIdempotency-Keyヘッダ名 */
export const IDEMPOTENCY_KEY_HEADER = 'X-Idempotency-Key';

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
 * PipelineReportApiClient のSSE接続耐性に関する設定。全項目省略可能。
 */
export interface PipelineReportApiClientResilienceOptions {
  fetchRetry?: Partial<FetchRetryOptions>;
  sseIdleTimeoutMs?: number;
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  pollTotalTimeoutMs?: number;
  pollNotFoundGraceMs?: number;
}

/**
 * PipelineReportApiClientの設定
 */
export interface PipelineReportApiClientConfig {
  /** APIサーバーのベースURL（例: `https://aikata-api.example.com`） */
  baseUrl: string;
  /** JWTトークン。null の場合は Authorization ヘッダを付与しない（dev/debug用） */
  jwt: string | null;
  /** CLIのバージョン（AIKATA_PR_VERSION）。APIサーバー側でバージョン整合性チェックに使用 */
  version: string;
  /** SSE接続耐性オプション */
  resilience?: PipelineReportApiClientResilienceOptions;
}

/**
 * CLI→APIサーバー間のpipeline-report用SSEクライアント。
 *
 * Node.js組み込みのfetchを使用してAPIサーバーの `/api/v1/pipeline-report` を呼び出し、
 * SSEレスポンスストリームをパースして最終的なレポート結果を返す。
 *
 * SSE接続耐性:
 * - リクエストセット開始時に Idempotency-Key（UUID v4）を1度だけ生成、リトライ全体で同じキーを使用
 * - fetch 失敗時に最大5回（デフォルト）リトライ
 * - SSE idle timeout（最後のイベント受信から60秒無音）でフォールバックポーリングへ移行
 * - SSE result 未受信終端 → フォールバックポーリングへ移行
 * - サーバから duplicated イベント受信 → フォールバックポーリング（既存jobId）へ移行
 */
export class PipelineReportApiClient {
  private readonly baseUrl: string;
  private readonly jwt: string | null;
  private readonly version: string;
  private readonly resilience: PipelineReportApiClientResilienceOptions;

  constructor(config: PipelineReportApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.jwt = config.jwt;
    this.version = config.version;
    this.resilience = config.resilience ?? {};
  }

  /**
   * pipeline-report APIを呼び出し、SSEレスポンスを処理する。
   *
   * @param request - pipeline-reportリクエスト
   * @param handlers - 進捗・エラー・requestId 受信コールバック（全て必須）
   * @returns 最終的な `result` イベントのペイロード（SSE切断時はGET /jobs/{id}フォールバック経由）
   */
  async run(
    request: PipelineReportApiRequest,
    handlers: PipelineReportApiClientHandlers,
  ): Promise<PipelineReportApiResult> {
    const url = `${this.baseUrl}/api/v1/pipeline-report`;
    const idempotencyKey = randomUUID();

    // jwt が null の場合は Authorization ヘッダを付与しない
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [VERSION_HEADER]: this.version,
      [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
    };
    if (this.jwt !== null) {
      headers['Authorization'] = `Bearer ${this.jwt}`;
    }

    const fetchRetryOptions: FetchRetryOptions = {
      ...DEFAULT_FETCH_RETRY,
      ...this.resilience.fetchRetry,
    };

    // fetchリトライ（接続失敗・5xxを最大N回再送、同じIdempotency-Keyで送信するためAI処理は重複しない）
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      },
      fetchRetryOptions,
    );

    // X-Request-Idヘッダの抽出（エラー応答でも付与される想定のため、!response.okより先に取得）
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    if (requestId) {
      handlers.onRequestId(requestId);
    }

    // 非SSEエラー（5xxはfetchWithRetryで処理済みのためここには来ない、4xxのみ）
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
    const sseOutcome = await this.parseSSEStream(response.body, handlers);

    if (sseOutcome.kind === 'result') {
      return sseOutcome.payload;
    }

    // duplicated か stream-ended-without-result → フォールバックポーリング
    const fallbackJobId = sseOutcome.kind === 'duplicated' ? sseOutcome.existingJobId : requestId;
    if (!fallbackJobId) {
      const err = new Error(
        'SSE stream ended without result event and no jobId is available for polling',
      );
      handlers.onError(err);
      throw err;
    }

    try {
      return (await pollJobResult(
        {
          apiUrl: this.baseUrl,
          jobId: fallbackJobId,
          jwtToken: this.jwt,
          version: this.version,
          userId: request.userId,
          intervalMs: this.resilience.pollIntervalMs ?? DEFAULT_POLL_OPTIONS.intervalMs,
          maxIntervalMs: this.resilience.pollMaxIntervalMs ?? DEFAULT_POLL_OPTIONS.maxIntervalMs,
          totalTimeoutMs: this.resilience.pollTotalTimeoutMs ?? DEFAULT_POLL_OPTIONS.totalTimeoutMs,
          notFoundGraceMs:
            this.resilience.pollNotFoundGraceMs ?? DEFAULT_POLL_OPTIONS.notFoundGraceMs,
        },
        VERSION_HEADER,
      )) as PipelineReportApiResult;
    } catch (err) {
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /**
   * SSEストリームをパースしてpipeline-report結果を返す
   *
   * 戻り値:
   * - { kind: 'result', payload }: result イベント受信成功
   * - { kind: 'duplicated', existingJobId }: サーバからduplicated進捗を受信
   * - { kind: 'stream-ended', reason }: ストリームが result/duplicated を受け取らずに終了
   *
   * errorイベントは throw する
   */
  private async parseSSEStream(
    body: ReadableStream<Uint8Array>,
    handlers: PipelineReportApiClientHandlers,
  ): Promise<
    | { kind: 'result'; payload: PipelineReportApiResult }
    | { kind: 'duplicated'; existingJobId: string }
    | { kind: 'stream-ended'; reason: 'idle-timeout' | 'reader-closed' }
  > {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const idleTimeoutMs = this.resilience.sseIdleTimeoutMs ?? 60_000;
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    try {
      while (true) {
        const idleTimer = new Promise<'idle-timeout'>((resolve) =>
          setTimeout(() => resolve('idle-timeout'), idleTimeoutMs),
        );
        const result = await Promise.race([reader.read(), idleTimer]);

        if (result === 'idle-timeout') {
          await reader.cancel().catch(() => {});
          return { kind: 'stream-ended', reason: 'idle-timeout' };
        }

        const { done, value } = result;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '') {
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
                case 'progress': {
                  const progressEvent = parsed as unknown as PipelineReportProgressEvent;
                  if (progressEvent.status === 'duplicated' && progressEvent.existingJobId) {
                    handlers.onProgress(progressEvent);
                    await reader.cancel().catch(() => {});
                    return {
                      kind: 'duplicated',
                      existingJobId: progressEvent.existingJobId,
                    };
                  }
                  handlers.onProgress(progressEvent);
                  break;
                }
                case 'result':
                  return {
                    kind: 'result',
                    payload: parsed as unknown as PipelineReportApiResult,
                  };
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

      return { kind: 'stream-ended', reason: 'reader-closed' };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 既にcancel/close済みなら無視
      }
    }
  }
}
