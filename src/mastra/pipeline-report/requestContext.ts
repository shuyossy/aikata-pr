import type { TargetJobSummary } from './types.js';

/**
 * ワークフローで使用するAI API設定
 * reviewのWorkflowRequestContextが各項目をトップレベルに持っているのに対し、
 * pipeline-reportはaiConfigとしてまとめることで注入/参照箇所の見通しを良くしている
 */
export interface WorkflowAiConfig {
  apiKey: string;
  endpointUrl: string;
  modelName: string;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
}

/**
 * PipelineAnalysisAgent用のRequestContext型
 *
 * 各種Tool（writeReport/patchReport/getReport/getJobLogDetail/getArtifactContent）は
 * ここから必要な値を引き出して動作する。
 */
export interface PipelineAnalysisAgentRequestContext {
  userId: string;
  projectId: number;
  pipelineId: number;
  projectDir: string;
  aiConfig: WorkflowAiConfig;
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
  /** 画像取得Tool経由で蓄積された画像データ（key = `${jobId}:${artifactPath}`） */
  pendingImages: Map<string, { base64: string; mimeType: string }>;
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
}

/**
 * ReportCompletenessJudgeAgent用のRequestContext型
 * 判定ロジックに必要なのはAI設定のみ
 */
export interface ReportCompletenessJudgeRequestContext {
  userId: string;
  aiConfig: WorkflowAiConfig;
}

/**
 * PipelineReportSummarizationAgent用のRequestContext型
 * 要約時にターゲットジョブ情報を参照する
 */
export interface PipelineReportSummarizationRequestContext {
  userId: string;
  aiConfig: WorkflowAiConfig;
  targetJobs: TargetJobSummary[];
}
