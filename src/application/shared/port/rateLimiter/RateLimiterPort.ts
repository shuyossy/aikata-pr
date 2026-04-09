/**
 * レートリミッターのポートインターフェース
 *
 * AI API呼び出しのレート制御を担う。
 * トークンバケットによるレート制限、ラウンドロビンによるプロジェクト間の公平なスケジューリング、
 * 429エラー時のグローバルスロットル（指数バックオフ）を提供する。
 */
export interface RateLimiterPort {
  /** API呼び出し許可を取得する。TokenBucket+RoundRobin+Cooldownで制御。上限到達時は待機する。 */
  acquirePermission(projectId: string): Promise<void>;
  /** 429エラーを報告する。全プロジェクトの発行を一時停止する。 */
  reportRateLimit(): void;
  /** API呼び出し成功を報告する。retryCountをリセットする。 */
  reportSuccess(): void;
  /** プロジェクトセッションを登録する（参照カウント方式）。 */
  registerProject(projectId: string): void;
  /** プロジェクトセッションを解除する（参照カウント方式）。 */
  unregisterProject(projectId: string): void;
  /** 全リソースを解放する（graceful shutdown用）。 */
  destroy(): void;
}
