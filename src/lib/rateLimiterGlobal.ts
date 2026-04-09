import type { RateLimiterPort } from '../application/shared/port/rateLimiter/index.js';

/**
 * レート制限のリトライ上限到達エラー
 *
 * RateLimiterのリトライ上限に達した場合にスローされる。
 * 呼び出し元でこのエラーを検知して処理を中断するために使用する。
 */
export class RateLimitExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitExhaustedError';
  }
}

// --- グローバルシングルトン管理（loggerと同じパターン） ---

/** シングルトンインスタンス */
let rateLimiterInstance: RateLimiterPort | null = null;

/**
 * レートリミッターを初期化する
 *
 * エントリーポイント（server.ts, index.ts）で具体実装を注入する。
 * 既に初期化済みの場合はエラーをスローする。
 */
export function initializeRateLimiter(limiter: RateLimiterPort): void {
  if (rateLimiterInstance) {
    throw new Error(
      'RateLimiter is already initialized. Call resetRateLimiter() before re-initializing.',
    );
  }
  rateLimiterInstance = limiter;
}

/**
 * 初期化済みのレートリミッターを取得する
 *
 * ワークフローステップ等、レートリミッターが必須のコンテキストで使用する。
 * 未初期化の場合はエラーをスローする。
 */
export function getRateLimiter(): RateLimiterPort {
  if (!rateLimiterInstance) {
    throw new Error('RateLimiter is not initialized. Call initializeRateLimiter() first.');
  }
  return rateLimiterInstance;
}

/**
 * レートリミッターを取得する（未初期化時はnullを返す）
 *
 * checklistSplit等のフォールバック動作が必要なコンテキストで使用する。
 * レートリミッター未初期化時は例外ではなくnullを返すため、
 * 呼び出し元でフォールバック動作を選択できる。
 */
export function getRateLimiterOrNull(): RateLimiterPort | null {
  return rateLimiterInstance;
}

/**
 * レートリミッターをリセットする（テスト用）
 */
export function resetRateLimiter(): void {
  rateLimiterInstance = null;
}
