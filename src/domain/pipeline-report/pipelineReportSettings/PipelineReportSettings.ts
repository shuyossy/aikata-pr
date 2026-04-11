import type { Job } from '../job/Job.js';

/**
 * pipeline-report 機能のユーザ設定を表す値オブジェクト。
 * レポートフォーマット・追加指示・ジョブ名フィルタを保持する。
 */
export class PipelineReportSettings {
  constructor(
    /** ジョブ 1 件分のレポートブロックのフォーマット（review の commentFormat と同じ粒度） */
    readonly jobReportFormat: string,
    /** Agent に渡す追加指示（任意） */
    readonly additionalInstructions: string | null,
    /** 分析対象に含めるジョブ名のパターン（空なら全て対象） */
    readonly includeJobPatterns: readonly RegExp[],
    /** 分析対象から除外するジョブ名のパターン */
    readonly excludeJobPatterns: readonly RegExp[],
  ) {}

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
