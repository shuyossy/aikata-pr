/**
 * GitLab CI/CD パイプライン
 */
export type PipelineStatus =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled';

export interface PipelineParams {
  projectId: number;
  pipelineId: number;
  ref: string;
  sha: string;
  status: PipelineStatus;
  webUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * GitLab CI/CD の単一パイプラインを表現するエンティティ。
 * プロジェクト・ref・sha・ステータスなどの基本情報を保持する。
 */
export class Pipeline {
  private constructor(
    readonly projectId: number,
    readonly pipelineId: number,
    readonly ref: string,
    readonly sha: string,
    readonly status: PipelineStatus,
    readonly webUrl: string,
    readonly createdAt: Date,
    readonly updatedAt: Date,
  ) {}

  /**
   * パラメータを検証して Pipeline を生成するファクトリ。
   */
  static of(params: PipelineParams): Pipeline {
    if (params.projectId <= 0) {
      throw new Error(`projectId must be positive, got ${params.projectId}`);
    }
    if (params.pipelineId <= 0) {
      throw new Error(`pipelineId must be positive, got ${params.pipelineId}`);
    }
    if (!params.sha) {
      throw new Error('sha must not be empty');
    }
    return new Pipeline(
      params.projectId,
      params.pipelineId,
      params.ref,
      params.sha,
      params.status,
      params.webUrl,
      params.createdAt,
      params.updatedAt,
    );
  }
}
