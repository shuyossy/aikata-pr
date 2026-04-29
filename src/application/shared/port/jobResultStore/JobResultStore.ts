import { JobResultRecord } from './types.js';

/**
 * ジョブ結果ストアのポートインターフェース
 *
 * SSE接続断時のフォールバック用に、ジョブの状態と最終結果を永続化する。
 * Idempotency-Keyによる重複検知と、jobIdによる結果再取得をサポートする。
 */
export interface JobResultStore {
  /**
   * ジョブレコードを保存する（新規作成・上書き両対応）
   */
  save(record: JobResultRecord): Promise<void>;

  /**
   * jobIdでレコードを取得する
   * @returns 該当レコード、なければnull
   */
  load(jobId: string): Promise<JobResultRecord | null>;

  /**
   * Idempotency-Keyでレコードを取得する（重複検知用）
   * @returns 該当レコード、なければnull
   */
  loadByIdempotencyKey(key: string): Promise<JobResultRecord | null>;

  /**
   * 期限切れレコードを掃除する
   * @param now 現在時刻
   * @returns 削除したレコード数
   */
  sweepExpired(now: Date): Promise<number>;
}
