import type { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import type {
  PipelineAnalysisWorkflowParams,
  PipelineAnalysisWorkflowResult,
  PipelineAnalysisWorkflowRunner,
} from '../../../../application/shared/port/workflow/index.js';
import type { ArtifactCacheEntryStatus } from '../../../../application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.js';
import { buildPipelineUserPrompt } from '../../../../application/pipeline-report/pipelineAnalysis/pipelineContextBuilder.js';
import type { PipelineAnalysisAgentRequestContext } from '../../../../mastra/pipeline-report/requestContext.js';
import type { TargetJobSummary } from '../../../../mastra/pipeline-report/types.js';
import { runWithLogContext } from '../../../../lib/logger.js';

/**
 * PipelineAnalysisWorkflowParams から Mastra ワークフローに渡す initialUserPrompt を組み立てる。
 *
 * pipelineContextBuilder.buildPipelineUserPrompt は ArtifactCacheEntryStatus を要求するが、
 * ポートには簡略化された `artifactCachePaths: Map<number, string | null>` しか流れてこない。
 * そのため下記の対応で最小限のステータスを再構築する:
 * - path が非 null → `cached`（詳細バイト数は不明なので 0 を入れる。`renderArtifactStatus` は cached 時に
 *   本文を出力しないため実害はなく、実際の artifact 一覧は artifactTrees から展開される）
 * - path が null → `error`（fetch 失敗 / 未取得の総称。理由詳細は失われる）
 */
function reconstructCacheStatuses(
  artifactCachePaths: Map<number, string | null>,
): Map<number, ArtifactCacheEntryStatus> {
  const statuses = new Map<number, ArtifactCacheEntryStatus>();
  for (const [jobId, zipPath] of artifactCachePaths) {
    if (zipPath !== null) {
      statuses.set(jobId, { kind: 'cached', zipPath, bytes: 0 });
    } else {
      statuses.set(jobId, { kind: 'error', reason: 'artifact unavailable' });
    }
  }
  return statuses;
}

/**
 * PipelineAnalysisWorkflowParams.targetJobs を Mastra ワークフロー入力用の TargetJobSummary 配列に変換する。
 */
function toTargetJobSummaries(params: PipelineAnalysisWorkflowParams): TargetJobSummary[] {
  return params.targetJobs.map((job) => ({
    id: job.id,
    name: job.name,
    stage: job.stage,
    status: job.status,
    duration: job.duration,
  }));
}

/**
 * PipelineAnalysisWorkflowParams から PipelineAnalysisAgentRequestContext を組み立てる。
 */
function buildAgentRequestContext(
  params: PipelineAnalysisWorkflowParams,
  targetJobSummaries: TargetJobSummary[],
): PipelineAnalysisAgentRequestContext {
  return {
    // WorkflowRequestContext 共通フィールド（review機能と同一構造）
    userId: params.userId,
    projectId: String(params.projectId),
    aiApiKey: params.aiConfig.apiKey,
    aiApiEndpointUrl: params.aiConfig.endpointUrl,
    aiModelName: params.aiConfig.modelName,
    projectDir: params.projectDir,
    openaiReasoningEffort: params.aiConfig.reasoningEffort ?? undefined,
    // pipeline-report 固有フィールド
    pipelineId: params.pipelineMeta.pipelineId,
    targetJobs: targetJobSummaries,
    overallTemplate: params.overallTemplate,
    jobReportFormat: params.jobReportFormat,
    additionalInstructions: params.additionalInstructions,
    commentLanguage: params.commentLanguage,
    resultFilePath: params.resultFilePath,
    skillsPaths: params.skillsPaths,
    folderTree: params.folderTree,
    folderTreeStripped: params.folderTreeStripped,
    omittedJobLogs: params.omittedJobLogs,
    artifactCachePaths: params.artifactCachePaths,
    hasImages: false,
    pendingImages: [],
    reportLockTimeoutMs: undefined,
    workspaceAvailable: true,
  };
}

/**
 * Mastra pipelineAnalysisWorkflow を PipelineAnalysisWorkflowRunner インターフェースにラップする。
 *
 * - コンストラクタで Mastra インスタンスを受け取り、テストでは fake を注入できる。
 * - 下流ロガーに userId バインディングを伝播させるため runWithLogContext で実行を包む。
 * - 進捗イベント（onProgress）として phase=analyzing / done を通知する。
 *   より細かいフェーズ通知は将来 workflow 内部 stream を購読する形に拡張可能。
 */
export class MastraPipelineAnalysisWorkflowRunner implements PipelineAnalysisWorkflowRunner {
  constructor(private readonly mastra: Mastra) {}

  async run(params: PipelineAnalysisWorkflowParams): Promise<PipelineAnalysisWorkflowResult> {
    // 下流（workflow step 内部の getLogger() 等）が自動で userId バインディングを受け取るようにする
    return runWithLogContext({ userId: params.userId }, async () => {
      // 解析フェーズ開始を通知
      params.onProgress({ type: 'phase', phase: 'analyzing' });

      // プロンプト組み立てに必要な cache statuses を再構築
      const artifactCacheStatuses = reconstructCacheStatuses(params.artifactCachePaths);
      const targetJobSummaries = toTargetJobSummaries(params);

      // ユーザプロンプトを事前組み立て
      const initialUserPrompt = buildPipelineUserPrompt({
        pipeline: params.pipelineMeta,
        targetJobs: params.targetJobs,
        jobLogs: params.jobLogsCompressed,
        artifactTrees: params.artifactTrees,
        artifactCacheStatuses,
        folderTree: params.folderTree,
        folderTreeStripped: params.folderTreeStripped,
      });

      // workflow inputSchema に対応する inputData
      const inputData = {
        initialUserPrompt,
        targetJobs: targetJobSummaries,
        overallTemplate: params.overallTemplate,
        jobReportFormat: params.jobReportFormat,
        additionalInstructions: params.additionalInstructions,
        resultFilePath: params.resultFilePath,
        commentLanguage: params.commentLanguage,
        maxCompletenessRetries: params.maxCompletenessRetries,
      };

      // RequestContext: workflow の requestContextSchema に合致するフィールドを詰める
      const agentRequestContext = buildAgentRequestContext(params, targetJobSummaries);
      // RequestContext: WorkflowRequestContext共通フィールド + pipeline-report固有フィールド
      const requestContext = new RequestContext<PipelineAnalysisAgentRequestContext>([
        ['userId', agentRequestContext.userId],
        ['projectId', agentRequestContext.projectId],
        ['aiApiKey', agentRequestContext.aiApiKey],
        ['aiApiEndpointUrl', agentRequestContext.aiApiEndpointUrl],
        ['aiModelName', agentRequestContext.aiModelName],
        ['projectDir', agentRequestContext.projectDir],
        ['openaiReasoningEffort', agentRequestContext.openaiReasoningEffort],
        ['pipelineId', agentRequestContext.pipelineId],
        ['targetJobs', agentRequestContext.targetJobs],
        ['overallTemplate', agentRequestContext.overallTemplate],
        ['jobReportFormat', agentRequestContext.jobReportFormat],
        ['additionalInstructions', agentRequestContext.additionalInstructions],
        ['commentLanguage', agentRequestContext.commentLanguage],
        ['resultFilePath', agentRequestContext.resultFilePath],
        ['skillsPaths', agentRequestContext.skillsPaths],
        ['folderTree', agentRequestContext.folderTree],
        ['folderTreeStripped', agentRequestContext.folderTreeStripped],
        ['omittedJobLogs', agentRequestContext.omittedJobLogs],
        ['artifactCachePaths', agentRequestContext.artifactCachePaths],
        ['hasImages', agentRequestContext.hasImages],
        ['pendingImages', agentRequestContext.pendingImages],
        ['reportLockTimeoutMs', agentRequestContext.reportLockTimeoutMs],
        ['workspaceAvailable', agentRequestContext.workspaceAvailable],
      ]);

      // Mastra workflow を実行
      const workflow = this.mastra.getWorkflow('pipelineAnalysisWorkflow');
      const run = await workflow.createRun();
      const result = (await run.start({ inputData, requestContext })) as {
        status: string;
        result?: PipelineAnalysisWorkflowResult;
        error?: Error;
      };

      if (result.status === 'failed') {
        throw new Error(
          `Pipeline analysis workflow failed: ${result.error?.message ?? 'Unknown error'}`,
          { cause: result.error },
        );
      }
      if (result.status !== 'success') {
        throw new Error(
          `Pipeline analysis workflow ended with unexpected status: ${result.status}`,
        );
      }

      // 完了フェーズを通知
      params.onProgress({ type: 'phase', phase: 'done' });

      if (!result.result) {
        throw new Error('Pipeline analysis workflow returned no result');
      }
      return {
        reportContent: result.result.reportContent,
        completenessVerified: result.result.completenessVerified,
        completenessRetries: result.result.completenessRetries,
      };
    });
  }
}
