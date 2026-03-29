import { getLogger } from './logger.js';
import { extractAPICallError, findStatusCodeInChain } from './aiApiError.js';

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
 * レート制限対応のリトライラッパー
 *
 * コールバックを実行し、レート制限エラーが発生した場合は
 * ランダム要素を含む指数バックオフで待機してリトライする。
 * レート制限以外のエラーはそのままスローする。
 */
export async function withRateLimitRetry<T>(
  callback: () => Promise<T>,
  config: RateLimitRetryConfig,
): Promise<T> {
  const logger = getLogger();

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
