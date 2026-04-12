import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { PipelineAnalysisAgentRequestContext } from '../requestContext.js';
import type { TargetJobSummary } from '../types.js';
import { executeAnalysisStep } from './steps/executeAnalysisStep.js';
import {
  verifyCompletenessStep,
  buildFeedbackWithReportPrompt,
} from './steps/verifyCompletenessStep.js';
import { buildPrepareStepForImageInjection } from '../../shared/prepareStepForImageInjection.js';
import { DEFAULT_RATE_LIMIT_RETRY_CONFIG } from '../../../lib/rateLimitRetry.js';
import { getLogger } from '../../../lib/logger.js';

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
export const workflowInputSchema = z.object({
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
export const workflowOutputSchema = z.object({
  reportContent: z.string(),
  completenessVerified: z.boolean(),
  completenessRetries: z.number(),
});

/**
 * ワークフローレベルの RequestContext バリデーション
 */
const requestContextSchema = z.object({
  userId: z.string(),
  projectId: z.string(),
  aiApiKey: z.string(),
  aiApiEndpointUrl: z.string(),
  aiModelName: z.string(),
  projectDir: z.string(),
  openaiReasoningEffort: z.string().optional(),
  pipelineId: z.number(),
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
  pendingImages: z.array(z.any()),
  reportLockTimeoutMs: z.number().optional(),
  workspaceAvailable: z.boolean(),
});

/**
 * dountil ループの状態管理スキーマ
 */
const loopStateSchema = z.object({
  /** 次に analysis agent に送信するプロンプト */
  prompt: z.string(),
  /** 使用中のスレッドID */
  threadId: z.string(),
  /** 判定が isComplete=true で完了したか */
  isComplete: z.boolean(),
  /** 不完全時の feedback プロンプト（judge 失敗時 null → ループ脱出扱い） */
  feedbackPrompt: z.string().nullable(),
  /** 累積コンテキスト長リカバリー回数 */
  contextLengthRecoveries: z.number(),
  /** 実行済み verify 回数（completenessRetries 出力値は max(0, これ - 1)） */
  completenessRetries: z.number(),
});

/**
 * Step A: 初期セットアップ（テンプレート書き込み + ループ初期状態）
 */
const prepareStep = createStep({
  id: 'pipeline-report-prepare',
  description: 'Write initial report skeleton and prepare loop state',
  inputSchema: workflowInputSchema,
  outputSchema: loopStateSchema,
  execute: async ({ inputData, requestContext }) => {
    const ctx = (requestContext as RequestContext<PipelineAnalysisAgentRequestContext>).all;

    // 初期テンプレート書き込み
    await fs.promises.writeFile(inputData.resultFilePath, ctx.overallTemplate, 'utf8');

    return {
      prompt: inputData.initialUserPrompt,
      threadId: randomUUID(),
      isComplete: false,
      feedbackPrompt: null,
      contextLengthRecoveries: 0,
      completenessRetries: 0,
    };
  },
});

/**
 * Step B: analyze + verify（dountil 本体）
 *
 * 1回のイテレーションで:
 * 1. executeAnalysisStep で analysis agent を呼び出し
 * 2. verifyCompletenessStep で judge agent が判定
 * 3. 不完全なら feedbackPrompt + レポート現物を次イテレーションの prompt にセット
 */
const analyzeAndVerifyStep = createStep({
  id: 'pipeline-report-analyze-and-verify',
  description: 'Run analysis agent then verify completeness with judge agent',
  inputSchema: loopStateSchema,
  outputSchema: loopStateSchema,
  execute: async ({ inputData, getInitData, mastra, requestContext }) => {
    const logger = getLogger();
    const initData = getInitData<typeof pipelineAnalysisWorkflow>();
    const analysisAgent = mastra.getAgent('pipelineAnalysisAgent');
    const judgeAgent = mastra.getAgent('reportCompletenessJudgeAgent');
    const summarizationAgent = mastra.getAgent('pipelineReportSummarizationAgent');
    const typedContext = requestContext as RequestContext<PipelineAnalysisAgentRequestContext>;

    // 1. analysis agent を実行
    // ツールはAgent定義のtoolsコールバックで動的に構築されるため、toolsets不要
    // 画像注入はprepareStepでpendingImagesをuserメッセージとして差し込む
    const analysis = await executeAnalysisStep({
      analysisAgent,
      summarizationAgent,
      requestContext: typedContext,
      currentPrompt: inputData.prompt,
      threadId: inputData.threadId,
      initialUserPromptForRecovery: initData.initialUserPrompt,
      feedbackPromptForRecovery: inputData.feedbackPrompt,
      extraGenerateOptions: {
        maxSteps: 50,
        prepareStep: buildPrepareStepForImageInjection(typedContext),
      },
      rateLimitRetryConfig: DEFAULT_RATE_LIMIT_RETRY_CONFIG,
    });

    // 2. judge agent で完成判定
    const verify = await verifyCompletenessStep({
      judgeAgent,
      requestContext: typedContext,
      rateLimitRetryConfig: DEFAULT_RATE_LIMIT_RETRY_CONFIG,
    });

    // 3. 次イテレーションの状態を構築
    let nextPrompt = inputData.prompt;
    let nextFeedbackPrompt: string | null = null;

    if (!verify.isComplete && verify.feedbackPrompt) {
      // レポート現状 + フィードバックを結合
      nextFeedbackPrompt = verify.feedbackPrompt;
      nextPrompt = buildFeedbackWithReportPrompt(verify.reportContent, verify.feedbackPrompt);
      logger.info(
        {
          attempt: inputData.completenessRetries + 1,
          missingItems: verify.lastJudgement?.missingItems?.length ?? 0,
          formatDeviations: verify.lastJudgement?.formatDeviations?.length ?? 0,
        },
        'Pipeline-report not complete; will rerun analysis with feedback',
      );
    }

    return {
      prompt: nextPrompt,
      threadId: analysis.finalThreadId,
      isComplete: verify.isComplete,
      feedbackPrompt: nextFeedbackPrompt,
      contextLengthRecoveries: inputData.contextLengthRecoveries + analysis.contextLengthRecoveries,
      completenessRetries: inputData.completenessRetries + 1,
    };
  },
});

/**
 * Step C: 最終化（レポート読み取り + 出力スキーマへの変換）
 */
const finalizeStep = createStep({
  id: 'pipeline-report-finalize',
  description: 'Read final report and produce workflow output',
  inputSchema: loopStateSchema,
  outputSchema: workflowOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const ctx = (requestContext as RequestContext<PipelineAnalysisAgentRequestContext>).all;
    const reportContent = await fs.promises.readFile(ctx.resultFilePath, 'utf8');
    return {
      reportContent,
      completenessVerified: inputData.isComplete,
      // completenessRetries は「再実行の回数」= 実行済 verify 回数 - 1
      completenessRetries: Math.max(0, inputData.completenessRetries - 1),
    };
  },
});

/**
 * pipeline-report ワークフロー
 *
 * 処理フロー:
 * 1. prepareStep: レポートスケルトンを書き込み、ループ初期状態を生成
 * 2. dountil(analyzeAndVerifyStep): analysis agent + judge agent を繰り返す
 *    - 完成 or judge 失敗(feedbackPrompt===null) or 再実行上限到達でループ脱出
 * 3. finalizeStep: 最終レポートを読み取り出力
 */
export const pipelineAnalysisWorkflow = createWorkflow({
  id: 'pipeline-analysis-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  requestContextSchema,
});

pipelineAnalysisWorkflow
  .then(prepareStep)
  .dountil(analyzeAndVerifyStep, async ({ inputData, getInitData }) => {
    const initData = getInitData<typeof pipelineAnalysisWorkflow>();
    // 脱出条件:
    // - isComplete: 判定完了
    // - feedbackPrompt === null かつ isComplete === false: judge 失敗で打ち切り
    // - completenessRetries >= maxCompletenessRetries + 1: 再実行上限到達
    //   （初回の実行は「再実行」ではないため +1）
    return (
      inputData.isComplete ||
      (inputData.feedbackPrompt === null && inputData.completenessRetries > 0) ||
      inputData.completenessRetries >= initData.maxCompletenessRetries + 1
    );
  })
  .then(finalizeStep)
  .commit();
