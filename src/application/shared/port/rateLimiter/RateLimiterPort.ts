/**
 * レートリミッターのポートインターフェース
 *
 * AI API呼び出しのレート制御を担う。
 * トークンバケットによるレート制限とラウンドロビンによる公平なスケジューリングを提供する。
 */
export interface RateLimiterPort {
  /** API呼び出し許可を取得する。上限到達時は待機する。 */
  acquirePermission(userId: string): Promise<void>;
  /** 429エラーを報告する。全ユーザーの発行を一時停止する。 */
  reportRateLimit(): void;
  /** API呼び出し成功を報告する。retryCountをリセットする。 */
  reportSuccess(): void;
  /** ユーザーセッションを登録する。 */
  registerUser(userId: string): void;
  /** ユーザーセッションを解除する。 */
  unregisterUser(userId: string): void;
}
