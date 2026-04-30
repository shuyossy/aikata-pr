import type {
  FailedJobResultRecord,
  JobResultStore,
  PendingJobResultRecord,
  SuccessJobResultRecord,
} from '../port/jobResultStore/index.js';

/**
 * バックグラウンドジョブが現在の処理段階を更新するために使うインターフェース。
 * 実体は jobResultStore の pending レコードに currentStep を書き込む。
 */
export interface BackgroundJobUpdater {
  /**
   * 現在の処理段階を更新する。
   * 失敗してもバックグラウンド処理は中断しない（best-effort）。
   */
  setCurrentStep(step: string): Promise<void>;
}

/**
 * バックグラウンドジョブが必要とするロガーインタフェース（pinoの最小サブセット）。
 * アプリケーション層がインフラ実装に依存しないよう、最小限のメソッドのみを要求する。
 */
export interface BackgroundJobLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * runBackgroundJob の引数
 */
export interface RunBackgroundJobArgs<TResult> {
  /** 同期保存済みの pending レコード（呼び出し側で先に save しておくこと） */
  pendingRecord: PendingJobResultRecord;
  /** ジョブ結果ストア */
  jobResultStore: JobResultStore;
  /**
   * AI処理本体。updater で currentStep を逐次更新できる。
   * 戻り値は success レコードの payload に入る。
   */
  work: (updater: BackgroundJobUpdater) => Promise<TResult>;
  /** ログ出力用logger */
  logger: BackgroundJobLogger;
  /**
   * バックグラウンド実行を任意のコンテキスト下で包むラッパ（pinoのrunWithLogContext相当）。
   * `lib/logger.ts` の `runWithLogContext` のシグネチャと同一。
   * テスト時は `(_bindings, fn) => fn()` のような恒等関数を渡せる。
   */
  runWithContext: <T>(bindings: Record<string, unknown>, fn: () => T) => T;
  /** runWithContext に渡すバインディング */
  contextBindings: Record<string, unknown>;
  /** 処理完了直前にクリーンアップしたい場合のフック（finallyで呼ばれる、best-effort） */
  cleanup?: () => Promise<void> | void;
}

/**
 * pending レコードの基本情報（status以外）を抜き出す
 */
function basePendingFields(
  pending: PendingJobResultRecord,
): Pick<
  PendingJobResultRecord,
  'jobId' | 'idempotencyKey' | 'feature' | 'userId' | 'createdAt' | 'expiresAt'
> {
  return {
    jobId: pending.jobId,
    idempotencyKey: pending.idempotencyKey,
    feature: pending.feature,
    userId: pending.userId,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

/**
 * バックグラウンドでAI処理を fire-and-forget で実行する。
 *
 * 動作:
 * 1. 処理本体 `work` を実行
 *    - 途中で `updater.setCurrentStep(step)` を呼ぶと pending レコードの currentStep が更新される
 * 2. 正常終了 → success レコードを保存
 * 3. 例外 → failed レコードを保存（保存失敗時はwarnログのみ）
 * 4. cleanup フックがあれば finally で呼ぶ
 *
 * 同期的にreturnし、Promiseを返さない（fire-and-forget）。
 * 呼び出し側（ハンドラ）はこの関数を呼んだ後、即座にHTTPレスポンスを返す。
 */
export function runBackgroundJob<TResult>(args: RunBackgroundJobArgs<TResult>): void {
  const { pendingRecord, jobResultStore, work, logger, runWithContext, contextBindings, cleanup } =
    args;

  const baseFields = basePendingFields(pendingRecord);

  const updater: BackgroundJobUpdater = {
    async setCurrentStep(step: string): Promise<void> {
      const updated: PendingJobResultRecord = {
        ...baseFields,
        status: 'pending',
        currentStep: step,
        updatedAt: new Date().toISOString(),
      };
      try {
        await jobResultStore.save(updated);
      } catch (err) {
        // currentStep更新失敗は致命的ではない（pendingのままジョブ自体は続行）
        logger.warn(
          { err, jobId: pendingRecord.jobId, step },
          'Failed to update currentStep on pending job record',
        );
      }
    },
  };

  // fire-and-forget。Promise.resolve().then() 経由で次のtickまで遅延させ、呼び出し側のレスポンス送信を妨げない。
  void Promise.resolve().then(async () => {
    try {
      await runWithContext(contextBindings, async () => {
        try {
          const result = await work(updater);
          const successRecord: SuccessJobResultRecord = {
            ...baseFields,
            status: 'success',
            payload: result,
            updatedAt: new Date().toISOString(),
          };
          await jobResultStore.save(successRecord);
          logger.info(
            { jobId: pendingRecord.jobId, feature: pendingRecord.feature },
            'Background job completed successfully',
          );
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.error(
            { err, jobId: pendingRecord.jobId, feature: pendingRecord.feature },
            'Background job failed',
          );
          const failedRecord: FailedJobResultRecord = {
            ...baseFields,
            status: 'failed',
            errorMessage,
            updatedAt: new Date().toISOString(),
          };
          try {
            await jobResultStore.save(failedRecord);
          } catch (saveErr) {
            logger.warn(
              { err: saveErr, jobId: pendingRecord.jobId },
              'Failed to save failed job record (best-effort)',
            );
          }
        }
      });
    } finally {
      if (cleanup) {
        try {
          await cleanup();
        } catch (cleanupErr) {
          logger.warn(
            { err: cleanupErr, jobId: pendingRecord.jobId },
            'Background job cleanup failed',
          );
        }
      }
    }
  });
}
