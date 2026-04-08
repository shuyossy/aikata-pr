import type { RateLimiterPort } from '../../../application/shared/port/rateLimiter/index.js';

/**
 * レートリミッターの設定
 */
export interface RateLimiterConfig {
  /** 1分間あたりのAPI発行上限 */
  rateLimitPerMin: number;
  /** バックオフ基本待機時間（ミリ秒） */
  baseDelayMs?: number;
  /** バックオフ最大待機時間（ミリ秒） */
  maxDelayMs?: number;
  /** バックオフ最大リトライ回数 */
  maxRetries?: number;
}

/**
 * ユーザーごとの待機キュー要素
 */
interface WaitingRequest {
  userId: string;
  resolve: () => void;
}

/**
 * レートリミッター実装
 *
 * 以下の3つの制御を組み合わせてAI API呼び出しのレートを制御する:
 * 1. TokenBucket - 1分間あたりのAPI発行上限を管理（時間経過でトークン補充）
 * 2. RoundRobinScheduler - ユーザー間の公平なスケジューリング
 * 3. GlobalThrottler - 429エラー時の全ユーザー一時停止（指数バックオフ + ジッター）
 */
export class RateLimiter implements RateLimiterPort {
  // --- TokenBucket ---
  /** 現在のトークン数 */
  private tokens: number;
  /** トークンの最大数 */
  private readonly maxTokens: number;
  /** トークン補充レート（ミリ秒あたり） */
  private readonly refillRatePerMs: number;
  /** 最後にトークンを補充した時刻 */
  private lastRefillTime: number;

  // --- RoundRobin ---
  /** 登録済みユーザーのリスト（順序付き） */
  private readonly users: string[] = [];
  /** 現在のラウンドロビンインデックス */
  private currentIndex = 0;
  /** ユーザーごとの待機キュー */
  private readonly userQueues: Map<string, WaitingRequest[]> = new Map();

  // --- GlobalThrottler ---
  /** 429エラー後のクールダウン終了時刻 */
  private cooldownUntil = 0;
  /** リトライ回数 */
  private retryCount = 0;
  /** バックオフ基本待機時間 */
  private readonly baseDelayMs: number;
  /** バックオフ最大待機時間 */
  private readonly maxDelayMs: number;
  /** 最大リトライ回数 */
  private readonly maxRetries: number;

  // --- 内部スケジューリング ---
  /** スケジューラーが動作中かどうか */
  private scheduling = false;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.rateLimitPerMin;
    this.tokens = config.rateLimitPerMin;
    // 1分（60000ms）でrateLimitPerMin個のトークンを補充
    this.refillRatePerMs = config.rateLimitPerMin / 60_000;
    this.lastRefillTime = Date.now();

    this.baseDelayMs = config.baseDelayMs ?? 1000;
    this.maxDelayMs = config.maxDelayMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 10;
  }

  /** API呼び出し許可を取得する。上限到達時は待機する。 */
  async acquirePermission(userId: string): Promise<void> {
    // 登録チェック
    if (!this.userQueues.has(userId)) {
      throw new Error(`User "${userId}" is not registered`);
    }

    // maxRetries超過チェック
    if (this.retryCount > this.maxRetries) {
      throw new Error(
        `Rate limit retry exhausted: ${this.retryCount} retries reached the maximum of ${this.maxRetries}`,
      );
    }

    return new Promise<void>((resolve) => {
      // ユーザーのキューにリクエストを追加
      const queue = this.userQueues.get(userId)!;
      queue.push({ userId, resolve });

      // スケジューラーが動いていなければ起動
      this.scheduleNext();
    });
  }

  /** 429エラーを報告する。全ユーザーの発行を一時停止する。 */
  reportRateLimit(): void {
    const delay = this.calculateBackoffDelay(this.retryCount);
    this.retryCount++;
    this.cooldownUntil = Date.now() + delay;
  }

  /** API呼び出し成功を報告する。retryCountをリセットする。 */
  reportSuccess(): void {
    this.retryCount = 0;
  }

  /** ユーザーセッションを登録する。 */
  registerUser(userId: string): void {
    if (this.userQueues.has(userId)) {
      // 冪等: 既に登録済みの場合は何もしない
      return;
    }
    this.users.push(userId);
    this.userQueues.set(userId, []);
  }

  /** ユーザーセッションを解除する。 */
  unregisterUser(userId: string): void {
    if (!this.userQueues.has(userId)) {
      // 冪等: 未登録の場合は何もしない
      return;
    }
    const index = this.users.indexOf(userId);
    if (index !== -1) {
      this.users.splice(index, 1);
      // currentIndexの調整
      if (this.currentIndex >= this.users.length && this.users.length > 0) {
        this.currentIndex = 0;
      }
    }
    this.userQueues.delete(userId);
  }

  /**
   * ラウンドロビンスケジューラー
   *
   * 待機キューからリクエストを取り出し、ラウンドロビン順で処理する。
   * トークンバケットとグローバルスロットルの制約を考慮する。
   */
  private scheduleNext(): void {
    if (this.scheduling) {
      return;
    }
    this.scheduling = true;
    this.processQueue();
  }

  /**
   * キュー処理のメインループ
   */
  private async processQueue(): Promise<void> {
    while (this.hasPendingRequests()) {
      // 1. グローバルスロットルの待機
      await this.waitForCooldown();

      // maxRetries超過チェック（cooldown中にreportRateLimitが呼ばれた可能性）
      if (this.retryCount > this.maxRetries) {
        this.drainAllWithError();
        break;
      }

      // 2. ラウンドロビンで次のリクエストを取得
      const request = this.getNextRoundRobinRequest();
      if (!request) {
        break;
      }

      // 3. トークンバケットの待機
      await this.waitForToken();

      // 4. トークンを消費してリクエストを許可
      this.consumeToken();
      request.resolve();
    }
    this.scheduling = false;
  }

  /**
   * 待機中のリクエストがあるかチェック
   */
  private hasPendingRequests(): boolean {
    for (const queue of this.userQueues.values()) {
      if (queue.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * ラウンドロビンで次に処理すべきリクエストを取得
   */
  private getNextRoundRobinRequest(): WaitingRequest | null {
    if (this.users.length === 0) {
      return null;
    }

    // 全ユーザーを一巡して、キューにリクエストがあるユーザーを探す
    for (let i = 0; i < this.users.length; i++) {
      const index = (this.currentIndex + i) % this.users.length;
      const userId = this.users[index];
      const queue = this.userQueues.get(userId);
      if (queue && queue.length > 0) {
        const request = queue.shift()!;
        this.currentIndex = (index + 1) % this.users.length;
        return request;
      }
    }

    return null;
  }

  /**
   * グローバルスロットルのクールダウンを待機
   */
  private async waitForCooldown(): Promise<void> {
    const now = Date.now();
    if (this.cooldownUntil > now) {
      const waitMs = this.cooldownUntil - now;
      await this.sleep(waitMs);
    }
  }

  /**
   * トークンバケットのトークンが利用可能になるまで待機
   */
  private async waitForToken(): Promise<void> {
    this.refillTokens();
    if (this.tokens >= 1) {
      return;
    }

    // トークンが1個補充されるまでの待機時間を計算
    const tokensNeeded = 1 - this.tokens;
    const waitMs = Math.ceil(tokensNeeded / this.refillRatePerMs);
    await this.sleep(waitMs);
    this.refillTokens();
  }

  /**
   * トークンを補充する
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    if (elapsed > 0) {
      const newTokens = elapsed * this.refillRatePerMs;
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefillTime = now;
    }
  }

  /**
   * トークンを1つ消費する
   */
  private consumeToken(): void {
    this.tokens -= 1;
  }

  /**
   * maxRetries超過時に全ての待機中リクエストをエラーで拒否する
   */
  private drainAllWithError(): void {
    for (const queue of this.userQueues.values()) {
      // キューに残っているリクエストはresolveしない
      // acquirePermissionの呼び出し元でretryCount超過が再チェックされる
      queue.length = 0;
    }
  }

  /**
   * バックオフ待機時間を計算する
   *
   * 指数バックオフ + ジッター:
   *   delay = min(baseDelayMs * 2^attempt + random(0, baseDelayMs), maxDelayMs)
   */
  private calculateBackoffDelay(attempt: number): number {
    const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * this.baseDelayMs;
    return Math.min(exponentialDelay + jitter, this.maxDelayMs);
  }

  /**
   * 指定ミリ秒待機する
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
