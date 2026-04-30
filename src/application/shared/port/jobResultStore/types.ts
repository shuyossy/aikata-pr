/**
 * ジョブの実行ステータス
 * - pending: 処理中（POST受信時に登録）
 * - success: 正常完了
 * - failed: 異常終了
 */
export type JobResultStatus = 'pending' | 'success' | 'failed';

/**
 * ジョブ結果の対象機能
 */
export type JobFeature = 'review' | 'pipeline-report';

/**
 * 全ステータスで共通のフィールド
 */
interface JobResultRecordBase {
  /** ジョブID（= X-Request-Id、UUID v4） */
  jobId: string;
  /** クライアントが発行する重複検知キー（UUID v4） */
  idempotencyKey: string;
  /** 対象機能名 */
  feature: JobFeature;
  /** 認可キー（保存時のユーザID） */
  userId: string;
  /** ISO8601形式の作成時刻 */
  createdAt: string;
  /** ISO8601形式の最終更新時刻 */
  updatedAt: string;
  /** ISO8601形式のレコード失効時刻 */
  expiresAt: string;
}

/**
 * 処理中のジョブレコード
 */
export interface PendingJobResultRecord extends JobResultRecordBase {
  status: 'pending';
  /**
   * 現在の処理段階を示す文字列キー（例: 'fetching_mr_info', 'cloning', 'reviewing'）。
   * バックグラウンドAI処理が節目で更新し、ポーリング中のCLIに進捗を伝えるために使う。
   */
  currentStep?: string;
}

/**
 * 正常完了したジョブレコード
 */
export interface SuccessJobResultRecord extends JobResultRecordBase {
  status: 'success';
  /** 機能ごとのApiResponseのJSONシリアライズ可能な値 */
  payload: unknown;
}

/**
 * 異常終了したジョブレコード
 */
export interface FailedJobResultRecord extends JobResultRecordBase {
  status: 'failed';
  /** エラーメッセージ */
  errorMessage: string;
}

/**
 * ジョブ結果レコード（ステータスで判別可能なUnion型）
 */
export type JobResultRecord =
  | PendingJobResultRecord
  | SuccessJobResultRecord
  | FailedJobResultRecord;
