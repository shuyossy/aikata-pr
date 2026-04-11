/**
 * GitLab CI/CD ジョブのステータス
 * @see https://docs.gitlab.com/ee/api/jobs.html
 */
export type JobStatus =
  | 'created'
  | 'pending'
  | 'running'
  | 'failed'
  | 'success'
  | 'canceled'
  | 'skipped'
  | 'waiting_for_resource'
  | 'manual'
  | 'preparing'
  | 'scheduled';

// 終了扱いとみなすステータスの集合（分析対象となる最終状態）
const TERMINATED: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'success',
  'failed',
  'canceled',
  'skipped',
]);

/**
 * ジョブが終了状態（success / failed / canceled / skipped）かを判定する。
 */
export function isTerminatedJobStatus(status: JobStatus): boolean {
  return TERMINATED.has(status);
}

/**
 * ジョブが成功状態（success）かを判定する。
 */
export function isSuccessfulJobStatus(status: JobStatus): boolean {
  return status === 'success';
}
