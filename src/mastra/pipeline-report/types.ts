import type { JobStatus } from '../../domain/pipeline-report/job/JobStatus.js';

/**
 * pipeline-report機能でAgent/Toolに渡すターゲットジョブのサマリ情報
 * JobエンティティからAgent層で必要な項目のみを抽出したDTO相当の型
 */
export interface TargetJobSummary {
  id: number;
  name: string;
  stage: string;
  status: JobStatus;
  duration: number | null;
}
