import { randomUUID } from 'node:crypto';
import {
  fetchWithRetry,
  pollJobResult,
  DEFAULT_FETCH_RETRY,
  DEFAULT_POLL_OPTIONS,
} from '../../httpClient/jobResultPolling.js';
import type { FetchRetryOptions } from '../../httpClient/jobResultPolling.js';

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
 * APIレスポンスの型（resultイベントのデータ）
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
 * 進捗イベントの型
 */
export interface ReviewProgressEvent {
  status: string;
  message?: string;
  /** Idempotency-Key一致で既存ジョブが見つかった時に existingJobId を含む */
  existingJobId?: string;
}

/** APIサーバーがレスポンスヘッダで返すリクエストID用ヘッダ名 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** CLI→APIサーバ間のバージョン伝達に使用するHTTPヘッダ名 */
export const VERSION_HEADER = 'X-Aikata-Version';

/** クライアント生成のIdempotency-Keyヘッダ名 */
export const IDEMPOTENCY_KEY_HEADER = 'X-Idempotency-Key';

/**
 * ReviewApiClient のSSE接続耐性に関する設定。
 * 全項目省略可能。未指定時はDEFAULT値を採用する。
 */
export interface ReviewApiClientResilienceOptions {
  /** fetchリトライ設定 */
  fetchRetry?: Partial<FetchRetryOptions>;
  /** SSE進捗イベント無音許容時間（ミリ秒） */
  sseIdleTimeoutMs?: number;
  /** フォールバックポーリングの初期間隔 */
  pollIntervalMs?: number;
  /** ポーリング最大間隔 */
  pollMaxIntervalMs?: number;
  /** ポーリング全体タイムアウト */
  pollTotalTimeoutMs?: number;
  /** 連続404継続時間。これを超えたら ApiServerJobNotStartedError throw */
  pollNotFoundGraceMs?: number;
}

/**
 * CLI→APIサーバー間のSSEクライアント
 *
 * Node.js組み込みのfetchを使用してAPIサーバーのレビューエンドポイントを呼び出し、
 * SSEレスポンスストリームをパースする。
 *
 * SSE接続耐性:
 * - リクエストセット開始時に Idempotency-Key（UUID v4）を1度だけ生成、リトライ全体で同じキーを使用
 * - fetch 失敗時に最大5回（デフォルト）リトライ
 * - SSE idle timeout（最後のイベント受信から60秒無音）でフォールバックポーリングへ移行
 * - SSE result 未受信終端 → フォールバックポーリングへ移行
 * - サーバから duplicated イベント受信 → フォールバックポーリング（既存jobId）へ移行
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
   * レビューAPIを呼び出し、SSEレスポンスを処理する
   *
   * @param request - レビューリクエスト
   * @param onProgress - 進捗イベントを受け取るコールバック
   * @param onRequestId - APIサーバーが返した`X-Request-Id`ヘッダを受け取るコールバック
   *   （ストリーム消費開始前に同期的に呼び出される。呼び出し側はこのIDをログに付与し、
   *   サーバー側ログとの相関キーとして利用する）
   */
  async executeReview(
    request: ReviewApiRequest,
    onProgress?: (event: ReviewProgressEvent) => void,
    onRequestId?: (requestId: string) => void,
  ): Promise<ReviewApiResponse> {
    const url = `${this.apiUrl}/api/v1/review`;
    const idempotencyKey = randomUUID();

    const fetchRetryOptions: FetchRetryOptions = {
      ...DEFAULT_FETCH_RETRY,
      ...this.resilience.fetchRetry,
    };

    // fetchリトライ（接続失敗・5xxを最大N回再送、同じIdempotency-Keyで送信するためAI処理は重複しない）
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.jwtToken}`,
          [VERSION_HEADER]: this.version,
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify(request),
      },
      fetchRetryOptions,
    );

    // X-Request-Idヘッダの抽出（エラー応答でも付与される想定のため、!response.okより先に取得）
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    if (requestId && onRequestId) {
      onRequestId(requestId);
    }

    // 非SSEエラー（400, 401, 5xxはfetchWithRetry内で処理済みのためここには来ない、4xxのみ）
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API request failed with status ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error('Response body is empty');
    }

    // SSEストリームをパース。result/duplicated/SSE切断 のいずれかで結了
    const sseOutcome = await this.parseSSEStream(response.body, onProgress);

    if (sseOutcome.kind === 'result') {
      return sseOutcome.payload;
    }

    // duplicated か stream-ended-without-result → フォールバックポーリング
    const fallbackJobId = sseOutcome.kind === 'duplicated' ? sseOutcome.existingJobId : requestId;
    if (!fallbackJobId) {
      throw new Error(
        'SSE stream ended without result event and no jobId is available for polling',
      );
    }

    return (await pollJobResult(
      {
        apiUrl: this.apiUrl,
        jobId: fallbackJobId,
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
    )) as ReviewApiResponse;
  }

  /**
   * SSEストリームをパースしてレビュー結果を返す
   *
   * 戻り値の種類:
   * - { kind: 'result', payload }: result イベント受信成功
   * - { kind: 'duplicated', existingJobId }: サーバから duplicated 進捗を受信（既存ジョブを示す）
   * - { kind: 'stream-ended', reason }: ストリームが result/duplicated を受け取らずに終了
   *
   * errorイベントは throw する（呼び出し側でcatch、フォールバックポーリングは行わない）
   */
  private async parseSSEStream(
    body: ReadableStream<Uint8Array>,
    onProgress?: (event: ReviewProgressEvent) => void,
  ): Promise<
    | { kind: 'result'; payload: ReviewApiResponse }
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
        // idleタイマー付きでreader.read()を待つ
        const idleTimer = new Promise<'idle-timeout'>((resolve) =>
          setTimeout(() => resolve('idle-timeout'), idleTimeoutMs),
        );
        const result = await Promise.race([reader.read(), idleTimer]);

        if (result === 'idle-timeout') {
          // 読み取りが idle timeout に達した: ストリームをキャンセルしてフォールバックへ
          await reader.cancel().catch(() => {});
          return { kind: 'stream-ended', reason: 'idle-timeout' };
        }

        const { done, value } = result;
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
                throw new Error(
                  `Failed to parse SSE event data for event "${currentEvent}": ${currentData}`,
                );
              }

              switch (currentEvent) {
                case 'progress': {
                  const progressEvent = parsed as unknown as ReviewProgressEvent;
                  // duplicated 進捗 = サーバ側で既存ジョブ検出 → 呼び出し側はポーリングへ移行
                  if (progressEvent.status === 'duplicated' && progressEvent.existingJobId) {
                    onProgress?.(progressEvent);
                    await reader.cancel().catch(() => {});
                    return {
                      kind: 'duplicated',
                      existingJobId: progressEvent.existingJobId,
                    };
                  }
                  onProgress?.(progressEvent);
                  break;
                }
                case 'result':
                  return {
                    kind: 'result',
                    payload: parsed as unknown as ReviewApiResponse,
                  };
                case 'error':
                  throw new Error(
                    `Review API error: ${(parsed['error'] as string) ?? 'Unknown error'}`,
                  );
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
      // readerを必ず解放
      try {
        reader.releaseLock();
      } catch {
        // 既にcancelやcloseされていれば無視
      }
    }
  }
}
