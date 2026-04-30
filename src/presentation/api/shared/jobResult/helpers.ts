import type {
  JobFeature,
  JobResultStore,
  PendingJobResultRecord,
} from '../../../../application/shared/port/jobResultStore/index.js';
import type { Logger } from 'pino';

/**
 * pendingレコードを構築するヘルパー
 */
export function buildPendingJobRecord(args: {
  jobId: string;
  idempotencyKey: string;
  feature: JobFeature;
  userId: string;
  ttlMs: number;
  now?: Date;
  currentStep?: string;
}): PendingJobResultRecord {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + args.ttlMs);
  const record: PendingJobResultRecord = {
    jobId: args.jobId,
    idempotencyKey: args.idempotencyKey,
    feature: args.feature,
    status: 'pending',
    userId: args.userId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  if (args.currentStep) {
    record.currentStep = args.currentStep;
  }
  return record;
}

/**
 * Idempotency-Key既存ジョブ検査の結果。
 *
 * - `no-existing`: 該当ジョブなし → 呼び出し側は通常通り新規ジョブとして処理開始
 * - `cached-success`: 完了済みジョブが見つかった → そのpayloadを200で返す
 * - `cached-failed`: 失敗済みジョブが見つかった → errorMessageを200で返す（status='failed'）
 * - `duplicated-pending`: 進行中ジョブが見つかった → 既存jobIdをstatus='pending'で返す（CLIは即pollingへ）
 * - `collision`: 同じIdempotency-Keyが別userIdで使われていた → 409で拒否
 * - `lookup-failed`: ストア検索が失敗（ストア障害）→ 呼び出し側は通常通り新規として処理（best-effort）
 */
export type ResolveExistingIdempotentJobOutcome =
  | { kind: 'no-existing' }
  | { kind: 'cached-success'; jobId: string; feature: JobFeature; payload: unknown }
  | { kind: 'cached-failed'; jobId: string; feature: JobFeature; errorMessage: string }
  | {
      kind: 'duplicated-pending';
      jobId: string;
      feature: JobFeature;
      currentStep?: string;
    }
  | { kind: 'collision'; existingUserId: string }
  | { kind: 'lookup-failed' };

/**
 * Idempotency-Keyで既存ジョブを検索し、状態に応じた outcome を返す。
 * 呼び出し側のハンドラはこの outcome を見てHTTPレスポンス（JSON）を組み立てる。
 *
 * 認可:
 * - 既存ジョブが見つかった場合、そのレコードのuserIdとリクエストuserIdを比較
 * - 不一致なら 'collision' を返し、ハンドラ側で409を返す
 */
export async function resolveExistingIdempotentJob(args: {
  jobResultStore: JobResultStore;
  idempotencyKey: string;
  userId: string;
  logger: Logger;
}): Promise<ResolveExistingIdempotentJobOutcome> {
  const { jobResultStore, idempotencyKey, userId, logger } = args;

  let existing;
  try {
    existing = await jobResultStore.loadByIdempotencyKey(idempotencyKey);
  } catch (err) {
    logger.warn({ err }, 'Failed to query existing job by Idempotency-Key (continuing as new job)');
    return { kind: 'lookup-failed' };
  }

  if (!existing) {
    return { kind: 'no-existing' };
  }

  if (existing.userId !== userId) {
    logger.warn(
      { existingUserId: existing.userId, requestUserId: userId },
      'Idempotency-Key collision detected (different userId)',
    );
    return { kind: 'collision', existingUserId: existing.userId };
  }

  if (existing.status === 'success') {
    logger.info(
      { existingJobId: existing.jobId, feature: existing.feature },
      'Idempotency-Key matched a completed job; returning cached result',
    );
    return {
      kind: 'cached-success',
      jobId: existing.jobId,
      feature: existing.feature,
      payload: existing.payload,
    };
  }

  if (existing.status === 'failed') {
    logger.info(
      { existingJobId: existing.jobId },
      'Idempotency-Key matched a failed job; returning cached error',
    );
    return {
      kind: 'cached-failed',
      jobId: existing.jobId,
      feature: existing.feature,
      errorMessage: existing.errorMessage,
    };
  }

  // pending: クライアントは即pollingへ移行する
  logger.info(
    { existingJobId: existing.jobId },
    'Idempotency-Key matched a pending job; instructing client to poll',
  );
  return {
    kind: 'duplicated-pending',
    jobId: existing.jobId,
    feature: existing.feature,
    ...(existing.currentStep ? { currentStep: existing.currentStep } : {}),
  };
}
