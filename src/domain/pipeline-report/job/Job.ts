import type { JobStatus } from './JobStatus.js';

export interface JobParams {
  id: number;
  name: string;
  stage: string;
  status: JobStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  duration: number | null;
  webUrl: string;
  failureReason: string | null;
  hasArtifacts: boolean;
  artifactsSize: number;
}

/**
 * GitLab CI/CD の単一ジョブを表現するエンティティ。
 * ステータスや実行時刻、失敗理由、アーティファクトのメタ情報を保持する。
 */
export class Job {
  private constructor(
    readonly id: number,
    readonly name: string,
    readonly stage: string,
    readonly status: JobStatus,
    readonly startedAt: Date | null,
    readonly finishedAt: Date | null,
    readonly duration: number | null,
    readonly webUrl: string,
    readonly failureReason: string | null,
    readonly hasArtifacts: boolean,
    readonly artifactsSize: number,
  ) {}

  /**
   * パラメータを検証して Job を生成するファクトリ。
   */
  static of(params: JobParams): Job {
    if (params.id <= 0) {
      throw new Error(`id must be positive, got ${params.id}`);
    }
    return new Job(
      params.id,
      params.name,
      params.stage,
      params.status,
      params.startedAt,
      params.finishedAt,
      params.duration,
      params.webUrl,
      params.failureReason,
      params.hasArtifacts,
      params.artifactsSize,
    );
  }
}
