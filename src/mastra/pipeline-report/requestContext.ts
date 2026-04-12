import type { WorkflowRequestContext } from '../shared/requestContext.js';
import type { PendingImageData } from '../shared/readImageCommon.js';
import type { TargetJobSummary } from './types.js';

/**
 * PipelineAnalysisAgent用のRequestContext型
 *
 * review機能と同様にWorkflowRequestContextを継承し、AI設定（aiApiKey / aiApiEndpointUrl / aiModelName /
 * openaiReasoningEffort）およびuserId / projectId / projectDirを共通インターフェースから受け取る。
 *
 * 各種Tool（writeReport/patchReport/getReport/getJobLogDetail/getArtifactContent）は
 * ここから必要な値を引き出して動作する。
 */
export interface PipelineAnalysisAgentRequestContext extends WorkflowRequestContext {
  pipelineId: number;
  targetJobs: TargetJobSummary[];
  overallTemplate: string;
  jobReportFormat: string;
  additionalInstructions: string | null;
  commentLanguage: string;
  resultFilePath: string;
  skillsPaths: string[];
  folderTree: string;
  folderTreeStripped: boolean;
  /** ジョブログ圧縮時に省略された中間部分をjobId単位で保持する */
  omittedJobLogs: Map<number, string>;
  /** ダウンロード済みアーティファクトzipのキャッシュパス（jobId → zipパス or null） */
  artifactCachePaths: Map<number, string | null>;
  /** 画像アーティファクトが1つ以上参照可能かどうか */
  hasImages: boolean;
  /** 画像取得Tool経由で蓄積された画像データ（review機能と同形式のPendingImageData配列） */
  pendingImages: PendingImageData[];
  /**
   * ファイルロック取得のタイムアウト（ミリ秒）。
   * テスト用フック: 未指定時はデフォルト 5000ms。本番では `undefined` を明示的に渡す。
   */
  reportLockTimeoutMs: number | undefined;
  /**
   * workspace tools（read-file/list-dir/read-image 等）が agent に登録されているかどうか。
   * workflow 層が workspace の利用可否を決定し、本フラグを true にセットした場合のみ
   * system プロンプトで workspace 関連セクションを案内する。
   */
  workspaceAvailable: boolean;
  /** CI/CD ジョブ定義（merged YAML）。取得できなかった場合は null */
  mergedYaml: string | null;
}

/**
 * ReportCompletenessJudgeAgent用のRequestContext型
 * 判定ロジックに必要なのはAI設定のみ（WorkflowRequestContextで充足）
 */
export type ReportCompletenessJudgeRequestContext = WorkflowRequestContext;

/**
 * PipelineReportSummarizationAgent用のRequestContext型
 * 要約時にターゲットジョブ情報を参照する
 */
export interface PipelineReportSummarizationRequestContext extends WorkflowRequestContext {
  targetJobs: TargetJobSummary[];
}
