import { getLogger } from './logger.js';
import { extractAPICallError, findStatusCodeInChain } from './aiApiError.js';
import { getRateLimiterOrNull, RateLimitExhaustedError } from './rateLimiterGlobal.js';

/**
 * レート制限リトライの設定
 */
export interface RateLimitRetryConfig {
  /** リトライ最大回数 */
  maxRetries: number;
  /** 基本待機時間（ミリ秒） */
  baseDelayMs: number;
  /** 最大待機時間（ミリ秒） */
  maxDelayMs: number;
}

/**
 * デフォルトのレート制限リトライ設定
 */
export const DEFAULT_RATE_LIMIT_RETRY_CONFIG: RateLimitRetryConfig = {
  maxRetries: 10,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

/**
 * レート制限エラーかどうかを判定する
 *
 * 以下の条件でレート制限と判定:
 * - statusCode === 429
 * - responseBodyにcase-insensitiveで "rate limit" が含まれる
 *
 * APICallError.isInstance()でのバージョン不一致に備え、
 * ダックタイピングによるstatusCode検出もフォールバックとして実施する。
 */
export function isRateLimitError(error: unknown): boolean {
  const apiError = extractAPICallError(error);
  if (apiError) {
    return (
      apiError.statusCode === 429 ||
      (typeof apiError.responseBody === 'string' &&
        apiError.responseBody.toLowerCase().includes('rate limit'))
    );
  }

  // フォールバック: APICallError.isInstance()でマッチしない場合でもstatusCode 429を検出
  const statusCode = findStatusCodeInChain(error);
  return statusCode === 429;
}

/**
 * バックオフ待機時間を計算する
 *
 * 指数バックオフ + ジッター:
 *   delay = min(baseDelayMs × 2^attempt + random(0, baseDelayMs), maxDelayMs)
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * レート制限リトライのオプション
 */
export interface WithRateLimitRetryOptions {
  /** プロジェクトID（指定時はグローバルレートリミッター経由で制御） */
  projectId?: string;
  /** レート制限検知時のコールバック（次回リトライ前に呼ばれる） */
  onRateLimitHit?: () => void;
}

/**
 * レート制限対応のリトライラッパー
 *
 * コールバックを実行し、レート制限エラーが発生した場合は
 * ランダム要素を含む指数バックオフで待機してリトライする。
 * レート制限以外のエラーはそのままスローする。
 *
 * レートリミッターが初期化済みかつprojectIdが指定された場合:
 * - レート制限をレートリミッターにreportし、レートリミッター経由で待機を行う
 * - per-agentリトライ回数をローカルで管理し、config.maxRetriesで上限判定を行う
 * それ以外の場合:
 * - 従来通りローカルでリトライ制御を行う（checklistSplit等のforeach前処理用）
 */
export async function withRateLimitRetry<T>(
  callback: () => Promise<T>,
  config: RateLimitRetryConfig,
  options?: WithRateLimitRetryOptions,
): Promise<T> {
  const logger = getLogger();
  const rateLimiter = getRateLimiterOrNull();
  const projectId = options?.projectId;
  const onRateLimitHit = options?.onRateLimitHit;

  if (rateLimiter && projectId) {
    // レートリミッター経由のグローバル制御（per-agentリトライカウンタ）
    let localRetryCount = 0;
    for (;;) {
      await rateLimiter.acquirePermission(projectId);
      try {
        const result = await callback();
        rateLimiter.reportSuccess();
        return result;
      } catch (error) {
        if (!isRateLimitError(error)) {
          // レート制限以外のエラー = APIが応答した = レート制限解除済み
          rateLimiter.reportSuccess();
          throw error;
        }

        rateLimiter.reportRateLimit();

        // per-agentリトライ上限判定（初回呼び出しはリトライに含めない）
        if (localRetryCount >= config.maxRetries) {
          throw new RateLimitExhaustedError(
            `Rate limit retry exhausted: ${localRetryCount} retries reached the maximum of ${config.maxRetries}`,
          );
        }
        localRetryCount++;
        logger.warn(
          {
            attempt: localRetryCount,
            maxRetries: config.maxRetries,
          },
          'Rate limit error detected, reported to rateLimiter',
        );
        if (onRateLimitHit) {
          onRateLimitHit();
        }
        // 次のループでacquirePermission()のcooldown待機後にリトライ
      }
    }
  }

  // レートリミッター未初期化またはprojectId未指定: ローカルリトライ（従来動作）
  for (let attempt = 0; ; attempt++) {
    try {
      return await callback();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= config.maxRetries) {
        throw error;
      }

      const delay = calculateBackoffDelay(attempt, config.baseDelayMs, config.maxDelayMs);
      logger.warn(
        { attempt: attempt + 1, maxRetries: config.maxRetries, delayMs: Math.round(delay) },
        `Rate limit error detected, retrying after ${Math.round(delay)}ms`,
      );

      await sleep(delay);
    }
  }
}
