import { setTimeout as sleep } from 'node:timers/promises';

/**
 * APIサーバへの接続自体が確立できなかった場合のエラー
 * （fetchリトライ全失敗時 or レスポンスヘッダ受信前のネットワーク障害時）
 *
 * ユーザフレンドリーなメッセージを含み、CLI 側で表示することを想定する。
 */
export class ApiServerConnectionError extends Error {
  constructor(
    public readonly retryCount: number,
    public readonly lastCause: unknown,
  ) {
    const causeMsg = lastCause instanceof Error ? lastCause.message : String(lastCause);
    super(
      `Failed to establish connection to API server after ${retryCount} retries (last cause: ${causeMsg}). The network may be intermittently unstable in this environment. Re-running this job often succeeds.`,
    );
    this.name = 'ApiServerConnectionError';
  }
}

/**
 * APIサーバへの接続は確立しジョブIDも取得できたが、サーバ側で処理が開始されないまま
 * 連続404が継続したことを示すエラー
 *
 * 「リクエストはサーバ手前のプロキシ等でdropされ、サーバには届いていない」と推定される
 * ケース。CLI 側で再実行を促すメッセージを表示する。
 */
export class ApiServerJobNotStartedError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly graceMs: number,
  ) {
    super(
      `Connected to API server (jobId=${jobId}) but the job did not start within ${graceMs}ms. The network was likely interrupted before the server began processing. Re-running this job often succeeds.`,
    );
    this.name = 'ApiServerJobNotStartedError';
  }
}

/**
 * ジョブ結果ポーリングがタイムアウトしたエラー
 */
export class JobResultPollTimeoutError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `Job (jobId=${jobId}) is still running after ${timeoutMs}ms. The server may still be processing or have failed silently. Check job status manually with: GET /api/v1/jobs/${jobId}`,
    );
    this.name = 'JobResultPollTimeoutError';
  }
}

/**
 * fetchリトライ設定
 */
export interface FetchRetryOptions {
  /** リトライ回数（既定5） */
  retryCount: number;
  /** 初期待機時間（ミリ秒、既定1000） */
  baseMs: number;
  /** 最大待機時間（ミリ秒、既定16000） */
  maxMs: number;
}

export const DEFAULT_FETCH_RETRY: FetchRetryOptions = {
  retryCount: 5,
  baseMs: 1000,
  maxMs: 16000,
};

/**
 * 5xxはリトライ対象、4xxはリトライしない
 */
function isRetriableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * 指数バックオフ + ±20%ジッタ
 */
function backoffWithJitter(attempt: number, options: FetchRetryOptions): number {
  const exp = Math.min(options.maxMs, options.baseMs * Math.pow(2, attempt));
  const jitter = exp * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.floor(exp + jitter));
}

/**
 * fetchリトライ実行
 *
 * - ネットワークエラー（fetchがthrow）: リトライ
 * - レスポンス5xx: リトライ
 * - レスポンス4xx: 即throw（呼び出し側でハンドリング）
 * - 全リトライ失敗: ApiServerConnectionError をthrow
 *
 * リトライ時は同じurl/initで再送するため、Idempotency-Keyヘッダ等は呼び出し側で
 * init.headersに含めておくこと。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchRetryOptions,
  onRetry?: (attempt: number, cause: unknown, waitMs: number) => void,
): Promise<Response> {
  let lastCause: unknown = null;

  for (let attempt = 0; attempt <= options.retryCount; attempt++) {
    try {
      const response = await fetch(url, init);
      if (!isRetriableStatus(response.status)) {
        return response;
      }
      // 5xx: リトライ対象。レスポンス本文を読み込んで原因記録
      const body = await response.text().catch(() => '');
      lastCause = new Error(`Server responded with ${response.status}: ${body}`);
    } catch (err) {
      lastCause = err;
    }

    if (attempt === options.retryCount) {
      // これ以上リトライしない
      break;
    }
    const waitMs = backoffWithJitter(attempt, options);
    onRetry?.(attempt + 1, lastCause, waitMs);
    await sleep(waitMs);
  }

  throw new ApiServerConnectionError(options.retryCount, lastCause);
}

/**
 * ジョブ結果ポーリング設定
 */
export interface JobResultPollOptions {
  /** APIサーバベースURL（例: https://aikata-api.example.com） */
  apiUrl: string;
  /** ポーリング対象 jobId（=サーバから受け取った X-Request-Id） */
  jobId: string;
  /** JWTトークン。null なら Authorization 付与しない（dev/debug） */
  jwtToken: string | null;
  /** バージョンヘッダ値 */
  version: string;
  /** JWT無効モード時の認可用 userId（クエリパラメータで送る） */
  userId: string;
  /** ポーリング初期間隔ミリ秒（既定5000） */
  intervalMs: number;
  /** ポーリング最大間隔ミリ秒（既定30000） */
  maxIntervalMs: number;
  /** ポーリング全体タイムアウトミリ秒（既定2100000=35分） */
  totalTimeoutMs: number;
  /** 連続404継続時間ミリ秒。これを超えたら ApiServerJobNotStartedError throw（既定60000=60秒） */
  notFoundGraceMs: number;
}

export const DEFAULT_POLL_OPTIONS: Pick<
  JobResultPollOptions,
  'intervalMs' | 'maxIntervalMs' | 'totalTimeoutMs' | 'notFoundGraceMs'
> = {
  intervalMs: 5_000,
  maxIntervalMs: 30_000,
  totalTimeoutMs: 2_100_000,
  notFoundGraceMs: 60_000,
};

/** GET /api/v1/jobs/{jobId} のレスポンス本体型 */
interface JobResultResponseBody {
  jobId: string;
  feature: 'review' | 'pipeline-report';
  status: 'pending' | 'success' | 'failed';
  payload?: unknown;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * ジョブ結果APIをポーリングして最終的なペイロードを取得する
 *
 * 戻り値: success時の payload（型は呼び出し側でキャスト）
 * Throw:
 * - ApiServerJobNotStartedError: 連続404が grace 超過
 * - JobResultPollTimeoutError: ポーリング全体タイムアウト
 * - Error(errorMessage): サーバ側で failed として記録された場合
 */
export async function pollJobResult(
  options: JobResultPollOptions,
  versionHeaderName: string,
  onPoll?: (info: { attempt: number; status: number; bodyStatus?: string }) => void,
): Promise<unknown> {
  const start = Date.now();
  let firstNotFoundAt: number | null = null;
  let interval = options.intervalMs;
  let attempt = 0;

  // jobIdをパスにエンコードしつつ、JWT無効モード用にuserIdクエリも常時付与（サーバ側の認可ロジックがJWTあれば優先）
  const url = `${options.apiUrl}/api/v1/jobs/${encodeURIComponent(options.jobId)}?userId=${encodeURIComponent(options.userId)}`;
  const headers: Record<string, string> = {
    [versionHeaderName]: options.version,
  };
  if (options.jwtToken !== null) {
    headers['Authorization'] = `Bearer ${options.jwtToken}`;
  }

  while (Date.now() - start < options.totalTimeoutMs) {
    attempt++;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers });
    } catch {
      // ネットワークエラーはリトライ
      const waitMs = backoffWithJitter(attempt - 1, {
        retryCount: 0,
        baseMs: interval,
        maxMs: options.maxIntervalMs,
      });
      await sleep(waitMs);
      interval = Math.min(options.maxIntervalMs, interval * 2);
      continue;
    }

    if (res.status === 200) {
      firstNotFoundAt = null;
      const body = (await res.json()) as JobResultResponseBody;
      onPoll?.({ attempt, status: res.status, bodyStatus: body.status });
      if (body.status === 'success') {
        return body.payload;
      }
      if (body.status === 'failed') {
        throw new Error(body.errorMessage ?? 'Job failed without error message');
      }
      // pending: バックオフ待機
    } else if (res.status === 404) {
      onPoll?.({ attempt, status: res.status });
      const now = Date.now();
      if (firstNotFoundAt === null) {
        firstNotFoundAt = now;
      } else if (now - firstNotFoundAt > options.notFoundGraceMs) {
        throw new ApiServerJobNotStartedError(options.jobId, options.notFoundGraceMs);
      }
    } else {
      onPoll?.({ attempt, status: res.status });
      const body = await res.text().catch(() => '');
      throw new Error(`Job result polling failed with unexpected status ${res.status}: ${body}`);
    }

    const waitMs = backoffWithJitter(attempt - 1, {
      retryCount: 0,
      baseMs: interval,
      maxMs: options.maxIntervalMs,
    });
    await sleep(waitMs);
    interval = Math.min(options.maxIntervalMs, interval * 2);
  }

  throw new JobResultPollTimeoutError(options.jobId, options.totalTimeoutMs);
}
