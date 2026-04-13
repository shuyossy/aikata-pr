import type { Job } from '../job/Job.js';

/**
 * ジョブ 1 件分のレポートブロックのデフォルトフォーマット。
 * ユーザは pipeline-report-settings.json の jobReportFormat で上書き可能。
 * プレースホルダ内の hint (`<...>`) は Agent への指示。列挙型 hint の場合は
 * 列挙値のみを出力すること。
 */
const DEFAULT_JOB_REPORT_FORMAT = `### ジョブ #<jobId> — \`<jobName>\` (<stage> / <status>)

- **実行時間:** <duration>
- **Web URL:** <webUrl>
- **AI 総合評価:** <以下の3つから1つだけ選ぶ: 「問題なし」「要注意」「問題あり」。「問題なし」= ログ・アーティファクトの観察範囲で特筆すべき懸念がない場合 / 「要注意」= GitLab 上は成功だが警告・スキップ・無視されたエラー等の疑わしい徴候がある、または失敗だが影響範囲が軽微な場合（要注意を出し過ぎてもユーザの認知負担が増えるので、真にユーザが確認すべきジョブに限定すること。つまり、ユーザがプロジェクトのコードベースを確認し必要によっては修正パッチをリリースしなければならない可能性がある場合は「要注意」とすること。警告がでているがユーザのコードベースに対してそこまで重要度・緊急度が高くない場合は問題なしとし、検出された問題に警告内容を記載すること） / 「問題あり」= ジョブが失敗している、または成功していても明確な問題（テストスキップ、エラー握り潰し、重要なリグレッション等）が検出されている場合>

**概要**
<1〜3文でこのジョブの顛末を要約>

**検出された問題**
<箇条書きで具体的な問題を列挙。GitLab 上は成功していても、ログから疑わしい徴候が見つかれば必ず記載する。何も検出されなかった場合は「検出なし」と書く>

**根拠（ログ・アーティファクト・コードベース）**
- \`<ログ行またはアーティファクト抜粋>\` — <なぜこれが根拠になるのか。アーティファクトについては中身を見て何かしらの判断をしたのか、それとも存在を確認して根拠としたのかわかる様に記載>

**推奨される次のアクション**
<具体的なアクション、または「特になし」>
`;

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

  /** デフォルト値でPipelineReportSettingsを生成する */
  static default(): PipelineReportSettings {
    return PipelineReportSettings.of({
      jobReportFormat: DEFAULT_JOB_REPORT_FORMAT,
      additionalInstructions: null,
      includeJobPatterns: [],
      excludeJobPatterns: [],
    });
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
