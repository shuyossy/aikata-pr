import type { SSEStreamingApi } from 'hono/streaming';
import type {
  JobResultStore,
  JobFeature,
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
}): PendingJobResultRecord {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + args.ttlMs);
  return {
    jobId: args.jobId,
    idempotencyKey: args.idempotencyKey,
    feature: args.feature,
    status: 'pending',
    userId: args.userId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * 既存ジョブ（Idempotency-Key一致）の処理結果。
 * trueなら呼び出し側はreturnして以降のAI処理をスキップする。
 */
export type ExistingJobOutcome = 'handled-and-stop' | 'continue';

/**
 * Idempotency-Keyで既存ジョブを検索し、見つかった場合はSSEで適切なイベントを送信して
 * 'handled-and-stop' を返す。
 *
 * 既存なし or load失敗時は 'continue' を返す（呼び出し側は通常通り処理を続ける）。
 *
 * - userId 不一致: errorイベント（クライアントは新jobIdで再試行可能）
 * - success: result + done
 * - failed: error
 * - pending: progress(status=duplicated, existingJobId)
 */
export async function handleExistingIdempotentJob(args: {
  jobResultStore: JobResultStore;
  stream: SSEStreamingApi;
  idempotencyKey: string;
  userId: string;
  logger: Logger;
}): Promise<ExistingJobOutcome> {
  const { jobResultStore, stream, idempotencyKey, userId, logger } = args;

  let existing;
  try {
    existing = await jobResultStore.loadByIdempotencyKey(idempotencyKey);
  } catch (err) {
    logger.warn(
      { err },
      'Failed to query existing job by Idempotency-Key (continuing as if no duplicate)',
    );
    return 'continue';
  }

  if (!existing) {
    return 'continue';
  }

  if (existing.userId !== userId) {
    logger.warn(
      { existingUserId: existing.userId, requestUserId: userId },
      'Idempotency-Key collision detected (different userId)',
    );
    await stream.writeSSE({
      event: 'error',
      data: JSON.stringify({
        error: 'Idempotency-Key conflicts with an existing job owned by a different user',
      }),
    });
    return 'handled-and-stop';
  }

  if (existing.status === 'success') {
    logger.info(
      { existingJobId: existing.jobId, feature: existing.feature },
      'Idempotency-Key matched a completed job; returning cached result',
    );
    await stream.writeSSE({
      event: 'result',
      data: JSON.stringify(existing.payload),
    });
    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({
        status: 'completed',
        message: 'Cached result returned (Idempotency-Key matched)',
      }),
    });
    return 'handled-and-stop';
  }

  if (existing.status === 'failed') {
    logger.info(
      { existingJobId: existing.jobId },
      'Idempotency-Key matched a failed job; returning cached error',
    );
    await stream.writeSSE({
      event: 'error',
      data: JSON.stringify({ error: existing.errorMessage }),
    });
    return 'handled-and-stop';
  }

  // pending: クライアントはこのSSEを早期に閉じてフォールバックポーリングへ移行する
  logger.info(
    { existingJobId: existing.jobId },
    'Idempotency-Key matched a pending job; instructing client to poll',
  );
  await stream.writeSSE({
    event: 'progress',
    data: JSON.stringify({
      status: 'duplicated',
      existingJobId: existing.jobId,
      message: 'Job is already running with this Idempotency-Key; please poll the existing jobId',
    }),
  });
  return 'handled-and-stop';
}
