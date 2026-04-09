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
}

/**
 * プロジェクトごとの待機キュー要素
 */
interface WaitingRequest {
  projectId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * レートリミッター実装
 *
 * 以下の3つの制御を組み合わせてAI API呼び出しのレートを制御する:
 * 1. TokenBucket - 1分間あたりのAPI発行上限を管理（時間経過でトークン補充）
 * 2. RoundRobinScheduler - プロジェクト間の公平なスケジューリング（参照カウント方式）
 * 3. GlobalThrottler - 429エラー時の全プロジェクト一時停止（指数バックオフ + ジッター）
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
  /** 登録済みプロジェクトのリスト（順序付き） */
  private readonly projects: string[] = [];
  /** 現在のラウンドロビンインデックス */
  private currentIndex = 0;
  /** プロジェクトごとの待機キュー */
  private readonly projectQueues: Map<string, WaitingRequest[]> = new Map();
  /** プロジェクトごとの参照カウント */
  private readonly projectRefCounts: Map<string, number> = new Map();

  // --- GlobalThrottler ---
  /** 429エラー後のクールダウン終了時刻 */
  private cooldownUntil = 0;
  /** リトライ回数 */
  private retryCount = 0;
  /** バックオフ基本待機時間 */
  private readonly baseDelayMs: number;
  /** バックオフ最大待機時間 */
  private readonly maxDelayMs: number;

  // --- 内部スケジューリング ---
  /** スケジューラーが動作中かどうか */
  private scheduling = false;

  // --- ライフサイクル ---
  /** destroyされたかどうか */
  private destroyed = false;
  /** アクティブなタイマーID（destroy時にクリアするため保持） */
  private activeTimerId: ReturnType<typeof setTimeout> | null = null;
  /** sleepのresolve関数（destroy時に即座にsleepを中断するため保持） */
  private sleepResolve: (() => void) | null = null;

  constructor(config: RateLimiterConfig) {
    if (!Number.isFinite(config.rateLimitPerMin) || config.rateLimitPerMin <= 0) {
      throw new Error('rateLimitPerMin must be a positive finite number');
    }

    this.maxTokens = config.rateLimitPerMin;
    this.tokens = config.rateLimitPerMin;
    // 1分（60000ms）でrateLimitPerMin個のトークンを補充
    this.refillRatePerMs = config.rateLimitPerMin / 60_000;
    this.lastRefillTime = Date.now();

    this.baseDelayMs = config.baseDelayMs ?? 1000;
    this.maxDelayMs = config.maxDelayMs ?? 60_000;
  }

  /** API呼び出し許可を取得する。上限到達時は待機する。 */
  async acquirePermission(projectId: string): Promise<void> {
    // destroyチェック
    if (this.destroyed) {
      throw new Error('RateLimiter has been destroyed');
    }

    // 登録チェック
    if (!this.projectQueues.has(projectId)) {
      throw new Error(`Project "${projectId}" is not registered`);
    }

    return new Promise<void>((resolve, reject) => {
      // プロジェクトのキューにリクエストを追加
      const queue = this.projectQueues.get(projectId);
      if (!queue) {
        // unregister等で既にキューが削除されている場合
        reject(new Error(`Project "${projectId}" is not registered`));
        return;
      }
      queue.push({ projectId, resolve, reject });

      // スケジューラーが動いていなければ起動
      this.scheduleNext();
    });
  }

  /** 429エラーを報告する。全プロジェクトの発行を一時停止する。 */
  reportRateLimit(): void {
    const delay = this.calculateBackoffDelay(this.retryCount);
    this.retryCount++;
    this.cooldownUntil = Date.now() + delay;
  }

  /** API呼び出し成功を報告する。retryCountをリセットする。 */
  reportSuccess(): void {
    this.retryCount = 0;
  }

  /** プロジェクトセッションを登録する（参照カウント方式）。 */
  registerProject(projectId: string): void {
    if (this.destroyed) {
      return;
    }

    const currentCount = this.projectRefCounts.get(projectId) ?? 0;
    this.projectRefCounts.set(projectId, currentCount + 1);

    if (currentCount === 0) {
      // 新規登録: ラウンドロビンリストとキューを作成
      this.projects.push(projectId);
      this.projectQueues.set(projectId, []);
    }
  }

  /** プロジェクトセッションを解除する（参照カウント方式）。 */
  unregisterProject(projectId: string): void {
    if (this.destroyed) {
      return;
    }

    const currentCount = this.projectRefCounts.get(projectId);
    if (currentCount === undefined) {
      // 冪等: 未登録の場合は何もしない
      return;
    }

    if (currentCount > 1) {
      // 他のリクエストがまだアクティブ
      this.projectRefCounts.set(projectId, currentCount - 1);
      return;
    }

    // 参照カウントが0になった → 完全削除

    // 待機中のPromiseをreject
    const queue = this.projectQueues.get(projectId);
    if (queue) {
      const error = new Error(`Project "${projectId}" has been unregistered`);
      for (const request of queue) {
        request.reject(error);
      }
    }

    // ラウンドロビンリストから削除
    const index = this.projects.indexOf(projectId);
    if (index !== -1) {
      this.projects.splice(index, 1);
      // currentIndexの調整
      if (index < this.currentIndex) {
        this.currentIndex--;
      } else if (this.currentIndex >= this.projects.length && this.projects.length > 0) {
        this.currentIndex = 0;
      }
    }

    this.projectQueues.delete(projectId);
    this.projectRefCounts.delete(projectId);
  }

  /** 全リソースを解放する（graceful shutdown用）。 */
  destroy(): void {
    this.destroyed = true;

    // アクティブなタイマーをクリアし、sleepを即座に中断
    if (this.activeTimerId !== null) {
      clearTimeout(this.activeTimerId);
      this.activeTimerId = null;
    }
    if (this.sleepResolve) {
      this.sleepResolve();
      this.sleepResolve = null;
    }

    // 全キューの待機Promiseをreject
    const error = new Error('RateLimiter has been destroyed');
    for (const queue of this.projectQueues.values()) {
      for (const request of queue) {
        request.reject(error);
      }
      queue.length = 0;
    }

    this.scheduling = false;
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
    try {
      while (this.hasPendingRequests()) {
        // destroyチェック
        if (this.destroyed) {
          break;
        }

        // 1. グローバルスロットルの待機
        await this.waitForCooldown();

        // destroyチェック（cooldown中にdestroyされた可能性）
        if (this.destroyed) {
          break;
        }

        // 2. ラウンドロビンで次のリクエストを取得
        const request = this.getNextRoundRobinRequest();
        if (!request) {
          break;
        }

        // 3. トークンバケットの待機
        await this.waitForToken();

        // destroyチェック（トークン待機中にdestroyされた可能性）
        if (this.destroyed) {
          break;
        }

        // 4. トークンを消費してリクエストを許可
        this.consumeToken();
        request.resolve();
      }
    } catch {
      // 予期しないエラー: 全キューをrejectしてスケジューラーを安全に停止
      this.drainAllWithError();
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * 待機中のリクエストがあるかチェック
   */
  private hasPendingRequests(): boolean {
    for (const queue of this.projectQueues.values()) {
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
    if (this.projects.length === 0) {
      return null;
    }

    // 全プロジェクトを一巡して、キューにリクエストがあるプロジェクトを探す
    for (let i = 0; i < this.projects.length; i++) {
      const index = (this.currentIndex + i) % this.projects.length;
      const projectId = this.projects[index];
      const queue = this.projectQueues.get(projectId);
      if (queue && queue.length > 0) {
        const request = queue.shift()!;
        this.currentIndex = (index + 1) % this.projects.length;
        return request;
      }
    }

    return null;
  }

  /**
   * グローバルスロットルのクールダウンを待機（延長にも対応）
   */
  private async waitForCooldown(): Promise<void> {
    while (this.cooldownUntil > Date.now()) {
      if (this.destroyed) {
        return;
      }
      const waitMs = this.cooldownUntil - Date.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
    }
  }

  /**
   * トークンバケットのトークンが利用可能になるまで待機
   */
  private async waitForToken(): Promise<void> {
    this.refillTokens();
    while (this.tokens < 1) {
      if (this.destroyed) {
        return;
      }
      // トークンが1個補充されるまでの待機時間を計算
      const tokensNeeded = 1 - this.tokens;
      const waitMs = Math.ceil(tokensNeeded / this.refillRatePerMs);
      await this.sleep(waitMs);
      this.refillTokens();
    }
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
    const error = new Error('RateLimiter internal error: queue processing failed unexpectedly');
    for (const queue of this.projectQueues.values()) {
      for (const request of queue) {
        request.reject(error);
      }
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
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.activeTimerId = setTimeout(() => {
        this.activeTimerId = null;
        this.sleepResolve = null;
        resolve();
      }, ms);
    });
  }
}
