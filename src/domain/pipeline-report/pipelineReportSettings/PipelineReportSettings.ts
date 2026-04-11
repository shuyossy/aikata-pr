import type { Job } from '../job/Job.js';

/**
 * PipelineReportSettings のファクトリパラメータ
 */
export interface PipelineReportSettingsParams {
  /** ジョブ 1 件分のレポートブロックのフォーマット（review の commentFormat と同じ粒度） */
  jobReportFormat: string;
  /** Agent に渡す追加指示（任意） */
  additionalInstructions: string | null;
  /** 分析対象に含めるジョブ名のパターン（空なら全て対象） */
  includeJobPatterns: readonly RegExp[];
  /** 分析対象から除外するジョブ名のパターン */
  excludeJobPatterns: readonly RegExp[];
}

/**
 * pipeline-report 機能のユーザ設定を表す値オブジェクト。
 * レポートフォーマット・追加指示・ジョブ名フィルタを保持する。
 */
export class PipelineReportSettings {
  private constructor(
    readonly jobReportFormat: string,
    readonly additionalInstructions: string | null,
    readonly includeJobPatterns: readonly RegExp[],
    readonly excludeJobPatterns: readonly RegExp[],
  ) {}

  /**
   * パラメータから PipelineReportSettings を生成するファクトリ。
   */
  static of(params: PipelineReportSettingsParams): PipelineReportSettings {
    return new PipelineReportSettings(
      params.jobReportFormat,
      params.additionalInstructions,
      params.includeJobPatterns,
      params.excludeJobPatterns,
    );
  }

  /**
   * 分析対象ジョブの選定ビジネスルール:
   * 1. selfJobId と一致するジョブ（自分自身のレポートジョブ）を除外
   * 2. includeJobPatterns が空でない場合、いずれかにマッチするもののみ通過
   * 3. excludeJobPatterns のいずれかにマッチするものを除外
   */
  filterJobs(jobs: readonly Job[], selfJobId: number | null): Job[] {
    return jobs.filter((job) => {
      if (selfJobId !== null && job.id === selfJobId) {
        return false;
      }
      if (this.includeJobPatterns.length > 0) {
        const included = this.includeJobPatterns.some((re) => re.test(job.name));
        if (!included) {
          return false;
        }
      }
      if (this.excludeJobPatterns.some((re) => re.test(job.name))) {
        return false;
      }
      return true;
    });
  }
}
