import { createWorkflow, createStep } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { PipelineAnalysisAgentRequestContext } from '../requestContext.js';
import type { TargetJobSummary } from '../types.js';
import { executeAnalysisStep } from './steps/executeAnalysisStep.js';
import {
  verifyCompletenessStep,
  type ReportCompletenessJudgement,
} from './steps/verifyCompletenessStep.js';
import { createToolset } from '../agents/pipelineAnalysisAgent.js';
import { DEFAULT_RATE_LIMIT_RETRY_CONFIG } from '../../../lib/rateLimitRetry.js';

/**
 * TargetJobSummary の Zod スキーマ
 */
const targetJobSummarySchema: z.ZodType<TargetJobSummary> = z.object({
  id: z.number(),
  name: z.string(),
  stage: z.string(),
  status: z.enum([
    'created',
    'pending',
    'running',
    'success',
    'failed',
    'canceled',
    'skipped',
    'manual',
    'scheduled',
    'waiting_for_resource',
    'preparing',
  ]),
  duration: z.number().nullable(),
});

/**
 * ワークフロー入力スキーマ
 *
 * ワークフローはプレゼンテーション/インフラ層で準備済みの serializable な値のみを受け取る。
 * 複雑な Map / 画像データ / アーティファクトキャッシュ等は RequestContext 側に載せる。
 */
const workflowInputSchema = z.object({
  /** 完全に組み立て済みのユーザプロンプト（パイプラインコンテキスト + folder tree + target jobs 等） */
  initialUserPrompt: z.string(),
  /** 対象ジョブ一覧 */
  targetJobs: z.array(targetJobSummarySchema),
  /** 全体レポートスケルトン */
  overallTemplate: z.string(),
  /** ジョブ1件分のレポートブロックフォーマット */
  jobReportFormat: z.string(),
  /** ユーザ指定の追加指示（未指定は null） */
  additionalInstructions: z.string().nullable(),
  /** レポート出力ファイルパス */
  resultFilePath: z.string(),
  /** コメント言語 */
  commentLanguage: z.string(),
  /** completeness verify の再実行上限 */
  maxCompletenessRetries: z.number().int().nonnegative(),
});

/**
 * ワークフロー出力スキーマ
 */
const workflowOutputSchema = z.object({
  reportContent: z.string(),
  completenessVerified: z.boolean(),
  completenessRetries: z.number(),
});

/**
 * ワークフローレベルの RequestContext バリデーション
 *
 * `PipelineAnalysisAgentRequestContext` の全フィールドを zod で検証するのは過剰なため、
 * 必須のコア値のみを網羅する（Mastra の requestContextSchema は内部的に構造チェックに使われる）。
 */
const requestContextSchema = z.object({
  userId: z.string(),
  projectId: z.number(),
  pipelineId: z.number(),
  projectDir: z.string(),
  aiConfig: z.object({
    apiKey: z.string(),
    endpointUrl: z.string(),
    modelName: z.string(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).nullable(),
  }),
  targetJobs: z.array(targetJobSummarySchema),
  overallTemplate: z.string(),
  jobReportFormat: z.string(),
  additionalInstructions: z.string().nullable(),
  commentLanguage: z.string(),
  resultFilePath: z.string(),
  skillsPaths: z.array(z.string()),
  folderTree: z.string(),
  folderTreeStripped: z.boolean(),
  omittedJobLogs: z.instanceof(Map),
  artifactCachePaths: z.instanceof(Map),
  hasImages: z.boolean(),
  pendingImages: z.instanceof(Map),
  reportLockTimeoutMs: z.number().optional(),
  workspaceAvailable: z.boolean(),
});

/**
 * Step 1: executeAnalysisStep を Mastra ステップとして包む
 */
const analysisExecutionStep = createStep({
  id: 'pipeline-report-execute-analysis',
  description: 'Run pipelineAnalysisAgent to fill in the report skeleton',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({
    initialReportContent: z.string(),
    finalThreadId: z.string(),
    contextLengthRecoveries: z.number(),
  }),
  execute: async ({ inputData, requestContext, mastra }) => {
    const analysisAgent = mastra.getAgent('pipelineAnalysisAgent');
    const summarizationAgent = mastra.getAgent('pipelineReportSummarizationAgent');

    // RequestContext は親から渡されるため、型を強制する
    const typedContext = requestContext as RequestContext<PipelineAnalysisAgentRequestContext>;

    // agent に渡す toolset を RequestContext から組み立てる
    const ctx = typedContext.all;
    const toolset = createToolset(ctx);

    const result = await executeAnalysisStep({
      analysisAgent,
      summarizationAgent,
      requestContext: typedContext,
      initialUserPrompt: inputData.initialUserPrompt,
      extraGenerateOptions: {
        toolsets: { pipelineAnalysis: toolset },
        maxSteps: 50,
      },
      rateLimitRetryConfig: DEFAULT_RATE_LIMIT_RETRY_CONFIG,
    });

    return {
      initialReportContent: result.reportContent,
      finalThreadId: result.finalThreadId,
      contextLengthRecoveries: result.contextLengthRecoveries,
    };
  },
});

/**
 * Step 2: verifyCompletenessStep を Mastra ステップとして包む
 */
const completenessVerificationStep = createStep({
  id: 'pipeline-report-verify-completeness',
  description:
    'Verify report completeness with reportCompletenessJudgeAgent and rerun analysis agent when needed',
  inputSchema: z.object({
    initialReportContent: z.string(),
    finalThreadId: z.string(),
    contextLengthRecoveries: z.number(),
  }),
  outputSchema: workflowOutputSchema,
  execute: async ({ inputData, getInitData, requestContext, mastra }) => {
    const initData = getInitData<typeof pipelineAnalysisWorkflow>();
    const analysisAgent = mastra.getAgent('pipelineAnalysisAgent');
    const judgeAgent = mastra.getAgent('reportCompletenessJudgeAgent');
    const summarizationAgent = mastra.getAgent('pipelineReportSummarizationAgent');

    const typedContext = requestContext as RequestContext<PipelineAnalysisAgentRequestContext>;
    const ctx = typedContext.all;
    const toolset = createToolset(ctx);

    const result = await verifyCompletenessStep({
      analysisAgent,
      judgeAgent,
      summarizationAgent,
      requestContext: typedContext,
      threadId: inputData.finalThreadId,
      maxCompletenessRetries: initData.maxCompletenessRetries,
      extraGenerateOptions: {
        toolsets: { pipelineAnalysis: toolset },
        maxSteps: 50,
      },
      rateLimitRetryConfig: DEFAULT_RATE_LIMIT_RETRY_CONFIG,
    });

    // TypeScript は下流でのみ型を使うため、lastJudgement は output から除外する
    const _unused: ReportCompletenessJudgement | null = result.lastJudgement;
    void _unused;

    return {
      reportContent: result.reportContent,
      completenessVerified: result.completenessVerified,
      completenessRetries: result.completenessRetries,
    };
  },
});

/**
 * pipeline-report ワークフロー
 *
 * 処理フロー:
 * 1. executeAnalysisStep: pipelineAnalysisAgent でレポートを書き上げる
 * 2. verifyCompletenessStep: reportCompletenessJudgeAgent で完全性を判定し、必要なら再実行
 */
export const pipelineAnalysisWorkflow = createWorkflow({
  id: 'pipeline-analysis-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  requestContextSchema,
});

pipelineAnalysisWorkflow.then(analysisExecutionStep).then(completenessVerificationStep).commit();
