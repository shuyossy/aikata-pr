import { calculateBackoffDelay, sleep, type RateLimitRetryConfig } from './rateLimitRetry.js';

/**
 * レート制限のリトライ上限到達エラー
 */
export class RateLimitExhaustedError extends Error {
  constructor(retryCount: number, maxRetries: number) {
    super(`Rate limit retry exhausted: ${retryCount} retries reached the maximum of ${maxRetries}`);
    this.name = 'RateLimitExhaustedError';
  }
}

/**
 * レート制限のグローバルコーディネーター
 *
 * 複数Agentが並列実行する際に、レート制限の状態をグローバルで一元管理する。
 * - acquirePermission(): API呼び出し前に呼ぶ。cooldown中はスタガー付きで待機。
 * - reportRateLimit(): レート制限エラー検知時に呼ぶ。
 * - isExhausted(): リトライ上限に到達したか判定。
 */
export class RateLimitCoordinator {
  private globalRetryCount = 0;
  private cooldownUntil = 0;
  private resumeQueue: Promise<void> = Promise.resolve();
  private readonly config: RateLimitRetryConfig;
  private readonly staggerIntervalMs: number;

  constructor(config: RateLimitRetryConfig, staggerIntervalMs = 200) {
    this.config = config;
    this.staggerIntervalMs = staggerIntervalMs;
  }

  /**
   * API呼び出し前にゲート通過する
   *
   * - cooldownなし: 即座にreturn
   * - cooldown中: cooldownUntilまで待機 + スタガー（Promiseキューで順番に再開）
   * - 上限到達: RateLimitExhaustedErrorをスロー
   */
  async acquirePermission(): Promise<void> {
    if (this.isExhausted()) {
      throw new RateLimitExhaustedError(this.globalRetryCount, this.config.maxRetries);
    }

    const now = Date.now();
    if (this.cooldownUntil <= now) {
      return;
    }

    // Promiseキューでスタガード・リトライを実現
    const previousInQueue = this.resumeQueue;
    let resolveMyTurn!: () => void;
    this.resumeQueue = new Promise<void>((resolve) => {
      resolveMyTurn = resolve;
    });

    // 前のAgentが完了するまで待機
    await previousInQueue;

    // 上限の再チェック（待機中にreportRateLimitが呼ばれた可能性）
    if (this.isExhausted()) {
      resolveMyTurn();
      throw new RateLimitExhaustedError(this.globalRetryCount, this.config.maxRetries);
    }

    // cooldownUntilまで待機（延長された場合は再度待機）
    while (this.cooldownUntil > Date.now()) {
      if (this.isExhausted()) {
        resolveMyTurn();
        throw new RateLimitExhaustedError(this.globalRetryCount, this.config.maxRetries);
      }
      const waitMs = this.cooldownUntil - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }

    // スタガーのため次のAgentは少し後に再開
    setTimeout(() => resolveMyTurn(), this.staggerIntervalMs);
  }

  /**
   * レート制限エラーを報告する
   *
   * globalRetryCountをインクリメントし、バックオフ計算に基づいてcooldownUntilを更新する。
   */
  reportRateLimit(): void {
    const delay = calculateBackoffDelay(
      this.globalRetryCount,
      this.config.baseDelayMs,
      this.config.maxDelayMs,
    );
    this.globalRetryCount++;
    this.cooldownUntil = Date.now() + delay;
  }

  /**
   * API呼び出し成功を報告する
   *
   * globalRetryCountを0にリセットする。
   * APIが正常に応答している状態でリトライ予算を回復させ、
   * 散発的なレート制限の蓄積による不要なexhausted判定を防ぐ。
   */
  reportSuccess(): void {
    this.globalRetryCount = 0;
  }

  /**
   * リトライ上限に到達したか判定する
   *
   * maxRetries=Nの場合、N回のリトライ（＝N+1回のAPI呼び出し）を許可する。
   * これは既存のwithRateLimitRetryおよびexecuteWithErrorRecoveryの
   * `attempt >= maxRetries` セマンティクスと一致する。
   */
  isExhausted(): boolean {
    return this.globalRetryCount > this.config.maxRetries;
  }

  /**
   * 現在のグローバルリトライ回数
   */
  get retryCount(): number {
    return this.globalRetryCount;
  }
}

// --- グローバルシングルトン管理（loggerと同じパターン） ---

/** シングルトンインスタンス */
let coordinatorInstance: RateLimitCoordinator | null = null;

/**
 * コーディネーターを初期化���る
 */
export function initializeCoordinator(
  config: RateLimitRetryConfig,
  staggerIntervalMs?: number,
): RateLimitCoordinator {
  if (coordinatorInstance) {
    throw new Error(
      'RateLimitCoordinator is already initialized. Call resetCoordinator() before re-initializing.',
    );
  }

  coordinatorInstance = new RateLimitCoordinator(config, staggerIntervalMs);
  return coordinatorInstance;
}

/**
 * 初期化済みのコーディネーターを取得する
 */
export function getCoordinator(): RateLimitCoordinator {
  if (!coordinatorInstance) {
    throw new Error('RateLimitCoordinator is not initialized. Call initializeCoordinator() first.');
  }
  return coordinatorInstance;
}

/**
 * コーディネーターを取得する（未初期化時はnullを返す）
 *
 * checklistSplit等のforeach前処理で使用。
 * コーディネーター未初期化時は例外ではなくnullを返すため、
 * 呼び出し元でフォールバック動作を選択できる。
 */
export function getCoordinatorOrNull(): RateLimitCoordinator | null {
  return coordinatorInstance;
}

/**
 * コーディネーターをリセットする（テスト用）
 */
export function resetCoordinator(): void {
  coordinatorInstance = null;
}
