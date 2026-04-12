import type { Pipeline } from '../../../../domain/pipeline-report/pipeline/Pipeline.js';
import type { Job } from '../../../../domain/pipeline-report/job/Job.js';
import type { ArtifactTree } from '../../../../domain/pipeline-report/artifact/ArtifactTree.js';
import type { ArtifactCacheEntryStatus } from '../../../pipeline-report/pipelineAnalysis/ArtifactCacheManager.js';

/**
 * pipeline-report 機能の AI 分析ワークフロー実行パラメータ。
 * Mastra Workflow の入力を抽象化したポート用 DTO。
 */
export interface PipelineAnalysisWorkflowParams {
  userId: string;
  projectId: number;
  pipelineMeta: Pipeline;
  targetJobs: Job[];
  /** ジョブ ID -> 圧縮済みログ本文 */
  jobLogsCompressed: Map<number, string>;
  /** ジョブ ID -> 中央部省略部分の全文（Agent が tool 経由で取得するための保持領域） */
  omittedJobLogs: Map<number, string>;
  /** CI/CD ジョブ定義（merged YAML）。取得できなかった場合は null */
  mergedYaml: string | null;
  artifactTrees: ArtifactTree[];
  folderTree: string;
  folderTreeStripped: boolean;
  overallTemplate: string;
  jobReportFormat: string;
  additionalInstructions: string | null;
  commentLanguage: string;
  skillsPaths: string[];
  resultFilePath: string;
  projectDir: string;
  /** ジョブ ID -> artifacts キャッシュステータス（no-artifacts / cached / error 等の詳細を保持） */
  artifactCacheStatuses: Map<number, ArtifactCacheEntryStatus>;
  maxCompletenessRetries: number;
  aiConfig: {
    apiKey: string;
    endpointUrl: string;
    modelName: string;
    reasoningEffort: 'low' | 'medium' | 'high' | null;
  };
  /**
   * 進捗イベントのコールバック。
   * 呼び出し側で進捗を気にしない場合は no-op (`() => {}`) を渡すこと。
   * AGENTS.md「関数の引数は特別な理由がない限りオプショナルは避けること」に従い必須化している。
   */
  onProgress: (event: PipelineAnalysisProgressEvent) => void;
}

/**
 * ワークフロー実行中のイベント通知。
 * API サーバーの SSE ストリームなどに転送する用途を想定。
 */
export type PipelineAnalysisProgressEvent =
  | { type: 'phase'; phase: 'analyzing' | 'verifying' | 'recovery' | 'done' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'retry'; reason: string; retryCount: number };

/**
 * pipeline-report 機能の AI 分析ワークフロー実行結果。
 */
export interface PipelineAnalysisWorkflowResult {
  reportContent: string;
  completenessVerified: boolean;
  completenessRetries: number;
}

/**
 * pipeline-report 機能の AI 分析ワークフロー実行ポート（Mastra Workflow のラッパ）。
 */
export interface PipelineAnalysisWorkflowRunner {
  run(params: PipelineAnalysisWorkflowParams): Promise<PipelineAnalysisWorkflowResult>;
}
