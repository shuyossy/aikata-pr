import { randomUUID } from 'node:crypto';
import {
  fetchWithRetry,
  pollJobResult,
  DEFAULT_FETCH_RETRY,
  DEFAULT_POLL_OPTIONS,
} from '../../httpClient/jobResultPolling.js';
import type { FetchRetryOptions, JobResultPollInfo } from '../../httpClient/jobResultPolling.js';

/**
 * APIリクエストの型
 */
export interface ReviewApiRequest {
  /** 本テンプレートを実行したユーザID（通常は$GITLAB_USER_LOGIN）。APIサーバー側でログに記録される */
  userId: string;
  gitlabToken: string;
  projectId: string;
  mrIid: string;
  checklist: string[];
  reviewSettings?: {
    additionalInstructions?: string;
    concurrentReviewCount?: number | null;
    commentFormat?: string;
    ratings?: Array<{ label: string; definition: string }>;
    hiddenRatingLabels?: string[];
    suggestEnabledRatingLabels?: string[];
    qualityGate?: {
      failureCriteria?: Array<{ ratingLabel: string; threshold: number }>;
    };
    mrCommentTitle?: string;
  };
  options?: {
    commentLanguage?: string;
    skillsPaths?: string[];
    treeMaxDepth?: number;
  };
}

/**
 * APIレスポンスの型（ジョブ完了時のpayload）
 */
export interface ReviewApiResponse {
  results: Array<{
    checkItemContent: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError: boolean;
    errorMessage?: string;
  }>;
  commitHash: string;
  commitMessage: string;
  /** 変更提案一覧（APIサーバーからの応答に含まれる） */
  suggestions: Array<{
    checkItemContent: string;
    filePath: string;
    originalCode: string;
    suggestedCode: string;
    comment: string;
    newLine: number;
    linesAbove: number;
    linesBelow: number;
    oldPath: string;
    newPath: string;
  }>;
  /** 解決すべき旧suggestディスカッション */
  suggestResolveEntries: Array<{ discussionId: string; reason: string }>;
  /** MRのdiff_refs.base_sha */
  baseSha: string;
  /** MRのdiff_refs.head_sha */
  headSha: string;
  /** MRのdiff_refs.start_sha */
  startSha: string;
}

/**
 * POST /api/v1/review の応答本文
 */
interface ReviewJobResponse {
  jobId: string;
  feature: 'review';
  status: 'pending' | 'success' | 'failed';
  payload?: ReviewApiResponse;
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
 * ReviewApiClient のネットワーク耐性に関する設定。
 * 全項目省略可能。未指定時はDEFAULT値を採用する。
 */
export interface ReviewApiClientResilienceOptions {
  /** fetchリトライ設定 */
  fetchRetry?: Partial<FetchRetryOptions>;
  /** ポーリングの初期間隔 */
  pollIntervalMs?: number;
  /** ポーリング最大間隔 */
  pollMaxIntervalMs?: number;
  /** ポーリング全体タイムアウト */
  pollTotalTimeoutMs?: number;
  /** 連続404継続時間。これを超えたら ApiServerJobNotStartedError throw */
  pollNotFoundGraceMs?: number;
}

/**
 * CLI→APIサーバー間のレビューAPIクライアント。
 *
 * 動作:
 * 1. リクエストごとに UUID v4 で `jobId` と `idempotencyKey` を生成
 * 2. POST /api/v1/review に `X-Request-Id: jobId` と `X-Idempotency-Key` を送信し、
 *    JSON `{jobId, status, ...}` を即時受領する
 * 3. status が `success` ならpayloadを返却、`failed` ならエラーをthrow、
 *    `pending` なら `GET /api/v1/jobs/{jobId}` をポーリングして完了を待つ
 *
 * jobIdはCLI側で生成しヘッダで送信するため、レスポンス本文/ヘッダがプロキシ等で
 * 改変されてもCLIは必ずjobIdを把握できる（フォールバックポーリングが確実に動作する）。
 */
export class ReviewApiClient {
  private readonly apiUrl: string;
  private readonly jwtToken: string;
  private readonly version: string;
  private readonly resilience: ReviewApiClientResilienceOptions;

  constructor(
    apiUrl: string,
    jwtToken: string,
    version: string,
    resilience: ReviewApiClientResilienceOptions = {},
  ) {
    this.apiUrl = apiUrl;
    this.jwtToken = jwtToken;
    this.version = version;
    this.resilience = resilience;
  }

  /**
   * レビューAPIを呼び出し、ジョブ完了まで待機して結果を返す。
   *
   * @param request - レビューリクエスト
   * @param onPoll - ポーリング中の進捗（attempt/status/currentStep/elapsedMs）を受け取るコールバック
   * @param onJobIdReceived - リクエスト送信前に CLI生成のjobIdを通知するコールバック
   *   （ログにrequestIdを付与するために使う。サーバー側ログとの相関キー）
   */
  async executeReview(
    request: ReviewApiRequest,
    onPoll?: (info: JobResultPollInfo) => void,
    onJobIdReceived?: (jobId: string) => void,
  ): Promise<ReviewApiResponse> {
    const url = `${this.apiUrl}/api/v1/review`;
    const idempotencyKey = randomUUID();
    const jobId = randomUUID();
    onJobIdReceived?.(jobId);

    const fetchRetryOptions: FetchRetryOptions = {
      ...DEFAULT_FETCH_RETRY,
      ...this.resilience.fetchRetry,
    };

    // POST /api/v1/review 呼び出し（fetch失敗・5xx時は最大N回リトライ。同じIdempotency-Keyで送信するためAI処理は重複しない）
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.jwtToken}`,
          [VERSION_HEADER]: this.version,
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
          [REQUEST_ID_HEADER]: jobId,
        },
        body: JSON.stringify(request),
      },
      fetchRetryOptions,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`API request failed with status ${response.status}: ${body}`);
    }

    // 応答はJSON。Content-Typeも併せて確認
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Unexpected response content-type "${contentType}" (expected application/json). Body excerpt: ${body.slice(0, 200)}`,
      );
    }

    let parsed: ReviewJobResponse;
    try {
      parsed = (await response.json()) as ReviewJobResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse review API response as JSON: ${message}`, { cause: err });
    }

    // 既存ジョブヒットの即時応答（success/failed）はそのまま処理
    if (parsed.status === 'success') {
      if (!parsed.payload) {
        throw new Error('Review API returned status=success without payload');
      }
      return parsed.payload;
    }
    if (parsed.status === 'failed') {
      throw new Error(parsed.errorMessage ?? 'Review failed without error message');
    }

    // pending: ポーリングで完了を待つ。サーバが返したjobId（CLI送信値と通常一致）を優先。
    const targetJobId = parsed.jobId || jobId;

    return (await pollJobResult(
      {
        apiUrl: this.apiUrl,
        jobId: targetJobId,
        jwtToken: this.jwtToken,
        version: this.version,
        userId: request.userId,
        intervalMs: this.resilience.pollIntervalMs ?? DEFAULT_POLL_OPTIONS.intervalMs,
        maxIntervalMs: this.resilience.pollMaxIntervalMs ?? DEFAULT_POLL_OPTIONS.maxIntervalMs,
        totalTimeoutMs: this.resilience.pollTotalTimeoutMs ?? DEFAULT_POLL_OPTIONS.totalTimeoutMs,
        notFoundGraceMs:
          this.resilience.pollNotFoundGraceMs ?? DEFAULT_POLL_OPTIONS.notFoundGraceMs,
      },
      VERSION_HEADER,
      onPoll,
    )) as ReviewApiResponse;
  }
}
