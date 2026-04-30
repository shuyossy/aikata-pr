import { randomUUID } from 'node:crypto';
import {
  fetchWithRetry,
  pollJobResult,
  DEFAULT_FETCH_RETRY,
  DEFAULT_POLL_OPTIONS,
} from '../../httpClient/jobResultPolling.js';
import type { FetchRetryOptions, JobResultPollInfo } from '../../httpClient/jobResultPolling.js';

/**
 * pipeline-report APIリクエストの型
 *
 * APIサーバーのpipelineReportRequestSchemaに合わせる。
 * includeJobPatterns / excludeJobPatterns は RegExp の source 文字列配列として渡す。
 */
export interface PipelineReportApiRequest {
  /** 本テンプレートを実行したユーザID（通常は$GITLAB_USER_LOGIN）。APIサーバー側でログに記録される */
  userId: string;
  /** GitLab APIトークン */
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
 * pipeline-report APIレスポンス（ジョブ完了時のpayload）
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
 * POST /api/v1/pipeline-report の応答本文
 */
interface PipelineReportJobResponse {
  jobId: string;
  feature: 'pipeline-report';
  status: 'pending' | 'success' | 'failed';
  payload?: PipelineReportApiResult;
  errorMessage?: string;
  currentStep?: string;
}

/** クライアント生成のIdempotency-Keyヘッダ名 */
export const IDEMPOTENCY_KEY_HEADER = 'X-Idempotency-Key';

/** CLIが生成したjobIdをサーバへ送信するためのHTTPヘッダ名 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** CLI→APIサーバ間のバージョン伝達に使用するHTTPヘッダ名 */
export const VERSION_HEADER = 'X-Aikata-Version';

/**
 * PipelineReportApiClient のハンドラ定義。
 */
export interface PipelineReportApiClientHandlers {
  /** ポーリング中の進捗（attempt/status/currentStep/elapsedMs）を受け取るコールバック */
  onPoll: (info: JobResultPollInfo) => void;
  /** リクエスト送信前にCLI生成のjobIdを通知するコールバック */
  onJobIdReceived: (jobId: string) => void;
  /**
   * AI処理がfailed（または応答エラー）として確定した時点で呼ばれるコールバック。
   * このコールバック後、本メソッドはErrorをthrowする。
   */
  onError: (error: Error) => void;
}

/**
 * PipelineReportApiClient のネットワーク耐性に関する設定。全項目省略可能。
 */
export interface PipelineReportApiClientResilienceOptions {
  fetchRetry?: Partial<FetchRetryOptions>;
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
  /** 接続耐性オプション */
  resilience?: PipelineReportApiClientResilienceOptions;
}

/**
 * CLI→APIサーバー間のpipeline-report用APIクライアント。
 *
 * 動作:
 * 1. リクエストごとに UUID v4 で `jobId` と `idempotencyKey` を生成
 * 2. POST /api/v1/pipeline-report に `X-Request-Id` と `X-Idempotency-Key` を送信、
 *    JSON `{jobId, status, ...}` を即時受領
 * 3. `success` ならpayloadを返却、`failed` ならエラーをthrow、
 *    `pending` なら GET /api/v1/jobs/{jobId} をポーリングして完了を待つ
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
   * pipeline-report APIを呼び出し、ジョブ完了まで待機して結果を返す。
   */
  async run(
    request: PipelineReportApiRequest,
    handlers: PipelineReportApiClientHandlers,
  ): Promise<PipelineReportApiResult> {
    const url = `${this.baseUrl}/api/v1/pipeline-report`;
    const idempotencyKey = randomUUID();
    const jobId = randomUUID();
    handlers.onJobIdReceived(jobId);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [VERSION_HEADER]: this.version,
      [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
      [REQUEST_ID_HEADER]: jobId,
    };
    if (this.jwt !== null) {
      headers['Authorization'] = `Bearer ${this.jwt}`;
    }

    const fetchRetryOptions: FetchRetryOptions = {
      ...DEFAULT_FETCH_RETRY,
      ...this.resilience.fetchRetry,
    };

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      },
      fetchRetryOptions,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const err = new Error(
        `Pipeline report API request failed with status ${response.status}: ${body}`,
      );
      handlers.onError(err);
      throw err;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      const body = await response.text().catch(() => '');
      const err = new Error(
        `Unexpected response content-type "${contentType}" (expected application/json). Body excerpt: ${body.slice(0, 200)}`,
      );
      handlers.onError(err);
      throw err;
    }

    let parsed: PipelineReportJobResponse;
    try {
      parsed = (await response.json()) as PipelineReportJobResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const e = new Error(`Failed to parse pipeline-report API response as JSON: ${message}`, {
        cause: err,
      });
      handlers.onError(e);
      throw e;
    }

    if (parsed.status === 'success') {
      if (!parsed.payload) {
        const err = new Error('Pipeline report API returned status=success without payload');
        handlers.onError(err);
        throw err;
      }
      return parsed.payload;
    }
    if (parsed.status === 'failed') {
      const err = new Error(parsed.errorMessage ?? 'Pipeline report failed without error message');
      handlers.onError(err);
      throw err;
    }

    // pending: ポーリング
    const targetJobId = parsed.jobId || jobId;

    try {
      return (await pollJobResult(
        {
          apiUrl: this.baseUrl,
          jobId: targetJobId,
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
        handlers.onPoll,
      )) as PipelineReportApiResult;
    } catch (err) {
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }
}
