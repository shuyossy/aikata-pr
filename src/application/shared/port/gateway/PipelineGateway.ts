import type { Pipeline } from '../../../../domain/pipeline-report/pipeline/Pipeline.js';
import type { Job } from '../../../../domain/pipeline-report/job/Job.js';

/**
 * GitLab CI/CD のパイプライン・ジョブ・アーティファクトを取得するためのゲートウェイ。
 * pipeline-report 機能のアプリケーション層から利用される。
 */
export interface PipelineGateway {
  /**
   * 対象パイプラインのメタ情報を取得する。
   */
  getPipeline(projectId: number, pipelineId: number): Promise<Pipeline>;

  /**
   * パイプライン配下のジョブ一覧を取得する。
   * @param options.includeRetried リトライされた古いジョブも含めるかどうか
   */
  getJobs(
    projectId: number,
    pipelineId: number,
    options: { includeRetried: boolean },
  ): Promise<Job[]>;

  /**
   * 指定ジョブのトレース（標準出力・標準エラー）を取得する。
   */
  getJobTrace(projectId: number, jobId: number): Promise<string>;

  /**
   * 指定ジョブの artifacts zip を destPath にダウンロードする。
   * maxBytes を超えた分は切り捨て (truncated=true) とする。
   */
  downloadArtifactArchive(
    projectId: number,
    jobId: number,
    destPath: string,
    options: { maxBytes: number },
  ): Promise<{ bytesWritten: number; truncated: boolean }>;
}
