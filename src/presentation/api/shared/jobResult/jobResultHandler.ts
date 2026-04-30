import type { JobResultStore } from '../../../../application/shared/port/jobResultStore/index.js';
import type { JobResultRecord } from '../../../../application/shared/port/jobResultStore/index.js';

/**
 * JobResultハンドラの依存
 */
export interface JobResultHandlerDeps {
  jobResultStore: JobResultStore;
}

/**
 * GET /jobs/{jobId} のレスポンス本体
 *
 * pendingステータスでは payload も errorMessage も undefined。
 * クライアントはstatusで処理を分岐する。
 */
export interface JobResultResponseBody {
  jobId: string;
  feature: 'review' | 'pipeline-report';
  status: 'pending' | 'success' | 'failed';
  payload?: unknown;
  errorMessage?: string;
  /** pending時のみ。サーバ側のバックグラウンド処理が現在実行中のステップキー */
  currentStep?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 認可結果を表す型。
 * 呼び出し側が statusコードを返す責務を持つ。
 */
export type AuthorizationOutcome = { kind: 'allow' } | { kind: 'deny'; reason: string };

/**
 * JobResultレコードへのアクセスを認可する
 *
 * - JWT有効モード（jwtUserLogin指定）: jwtUserLoginと保存userIdの一致を確認
 * - JWT無効モード（jwtUserLogin未指定）: queryUserIdと保存userIdの一致を確認
 *
 * 開発モード時もjobId漏洩経由での他ユーザ結果取得を最低限防止する。
 */
export function authorizeJobResultAccess(args: {
  record: JobResultRecord;
  jwtUserLogin: string | null;
  queryUserId: string | null;
}): AuthorizationOutcome {
  const { record, jwtUserLogin, queryUserId } = args;
  // JWT認証有効モード
  if (jwtUserLogin !== null) {
    if (jwtUserLogin === record.userId) {
      return { kind: 'allow' };
    }
    return { kind: 'deny', reason: 'JWT user_login does not match record userId' };
  }
  // JWT認証無効モード（開発時のみ）: クエリパラメータでの認可
  if (queryUserId === null || queryUserId.length === 0) {
    return { kind: 'deny', reason: 'userId query parameter is required when JWT is disabled' };
  }
  if (queryUserId === record.userId) {
    return { kind: 'allow' };
  }
  return { kind: 'deny', reason: 'userId query parameter does not match record userId' };
}

/**
 * JobResultRecordをレスポンス本体に変換する
 */
export function toJobResultResponseBody(record: JobResultRecord): JobResultResponseBody {
  const base: JobResultResponseBody = {
    jobId: record.jobId,
    feature: record.feature,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.status === 'success') {
    base.payload = record.payload;
  } else if (record.status === 'failed') {
    base.errorMessage = record.errorMessage;
  } else if (record.status === 'pending' && record.currentStep) {
    base.currentStep = record.currentStep;
  }
  return base;
}
