import { createWorkflow, createStep } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { splitChecklist } from './steps/checklistSplit.js';
import { executeReview } from './steps/reviewExecution.js';
import { IndexedChecklist } from '../indexedCheckItem.js';
import type { ReviewAgentRequestContext, WorkflowRequestContext } from '../requestContext.js';

/**
 * IndexedCheckItemのZodスキーマ（ワークフロー内部用）
 */
const indexedCheckItemSchema = z.object({
  id: z.number(),
  content: z.string(),
});

/**
 * ワークフロー出力用の結果スキーマ（外部API用）
 * 内部ではcheckItemIdで処理するが、外部にはcheckItemContentで返す
 */
const workflowResultItemSchema = z.object({
  checkItemContent: z.string(),
  ratingLabel: z.string(),
  ratingDefinition: z.string(),
  comment: z.string(),
  isError: z.boolean(),
  errorMessage: z.string().optional(),
});

/**
 * ワークフロー入力スキーマ
 * モデル設定（userId, aiApiKey, aiApiEndpointUrl, aiModelName）はRequestContextで渡す
 */
const workflowInputSchema = z.object({
  checkItemContents: z.array(z.string()),
  concurrentReviewCount: z.number(),
  ratings: z.array(
    z.object({
      label: z.string(),
      definition: z.string(),
    }),
  ),
  commentFormat: z.string(),
  additionalInstructions: z.string(),
  mrTitle: z.string(),
  mrDescription: z.string(),
  mrSourceBranch: z.string(),
  mrTargetBranch: z.string(),
  mrDiff: z.string(),
  mrCommitHash: z.string(),
  priorReviewResults: z
    .array(
      z.object({
        checkItemContent: z.string(),
        ratingLabel: z.string(),
        ratingDefinition: z.string(),
        comment: z.string(),
      }),
    )
    .nullable(),
  priorCommitMessages: z.array(z.string()).nullable(),
  priorDiffSincePrior: z.string().nullable(),
  skillsPaths: z.array(z.string()),
  resultFilePath: z.string(),
  folderTree: z.string(),
});

/**
 * ワークフロー出力スキーマ
 */
const workflowOutputSchema = z.object({
  results: z.array(workflowResultItemSchema),
});

/**
 * RequestContextのバリデーションスキーマ
 */
const requestContextSchema = z.object({
  userId: z.string(),
  aiApiKey: z.string(),
  aiApiEndpointUrl: z.string(),
  aiModelName: z.string(),
  projectDir: z.string(),
});

/**
 * Step 1: チェックリスト分割ステップ
 * チェックリストをconcurrentReviewCountに基づいて分割する
 */
const checklistSplitStep = createStep({
  id: 'checklist-split',
  description: 'チェックリストをconcurrentReviewCountに基づいて分割する',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({
    groups: z.array(z.array(indexedCheckItemSchema)),
  }),
  execute: async ({ inputData, requestContext, mastra }) => {
    const indexedChecklist = new IndexedChecklist(inputData.checkItemContents);
    const items = indexedChecklist.items.slice();

    // concurrentReviewCountが2以上かつ総チェック項目数より少ない場合はAI分割を実行
    const needsAiSplit =
      inputData.concurrentReviewCount > 1 && inputData.concurrentReviewCount < items.length;
    const checklistSplitAgent = mastra.getAgent('checklistSplitAgent');
    const agentContext = needsAiSplit ? { agent: checklistSplitAgent, requestContext } : null;

    const groups = await splitChecklist(items, inputData.concurrentReviewCount, agentContext);
    return {
      groups: groups.map((group) => group.map((item) => ({ id: item.id, content: item.content }))),
    };
  },
});

/**
 * Step 2: レビュー実行ステップ
 * 各グループのチェック項目をレビューする
 */
const reviewExecutionStep = createStep({
  id: 'review-execution',
  description: '各グループのチェック項目をレビューする',
  inputSchema: z.object({
    items: z.array(indexedCheckItemSchema),
  }),
  outputSchema: z.object({
    results: z.array(workflowResultItemSchema),
  }),
  execute: async ({ inputData, getInitData, requestContext, mastra }) => {
    const initData = getInitData<typeof reviewWorkflow>();
    const checkItems = inputData.items;

    // ReviewAgent用のRequestContextを組み立てる
    const workflowCtx = requestContext.all as WorkflowRequestContext;

    // 過去のレビュー結果を現在のグループのチェック項目のみにフィルタ
    const currentGroupContents = new Set(checkItems.map((item) => item.content));
    const filteredPriorResults =
      initData.priorReviewResults && initData.priorCommitMessages && initData.priorDiffSincePrior
        ? initData.priorReviewResults.filter((r) => currentGroupContents.has(r.checkItemContent))
        : null;

    const agentRequestContext = new RequestContext<ReviewAgentRequestContext>([
      ['userId', workflowCtx.userId],
      ['aiApiKey', workflowCtx.aiApiKey],
      ['aiApiEndpointUrl', workflowCtx.aiApiEndpointUrl],
      ['aiModelName', workflowCtx.aiModelName],
      ['projectDir', workflowCtx.projectDir],
      ['checkItems', checkItems],
      ['ratings', initData.ratings.map((r) => ({ label: r.label, definition: r.definition }))],
      ['commentFormat', initData.commentFormat],
      ['additionalInstructions', initData.additionalInstructions],
      ['mrTitle', initData.mrTitle],
      ['mrDescription', initData.mrDescription],
      ['mrSourceBranch', initData.mrSourceBranch],
      ['mrTargetBranch', initData.mrTargetBranch],
      ['mrDiff', initData.mrDiff],
      [
        'priorReviewContext',
        filteredPriorResults && filteredPriorResults.length > 0
          ? {
              results: filteredPriorResults.map((r) => ({
                checkItemContent: r.checkItemContent,
                ratingLabel: r.ratingLabel,
                comment: r.comment,
              })),
              commitMessages: initData.priorCommitMessages!,
              diffSincePrior: initData.priorDiffSincePrior!,
            }
          : null,
      ],
      ['skillsPaths', initData.skillsPaths],
      ['folderTree', initData.folderTree],
    ]);

    const reviewAgent = mastra.getAgent('reviewAgent');
    const results = await executeReview({
      checkItems,
      agent: reviewAgent,
      requestContext: agentRequestContext,
      resultFilePath: initData.resultFilePath,
    });

    return {
      results: results.map((r) => ({
        checkItemContent: r.checkItem.content,
        ratingLabel: r.rating.label,
        ratingDefinition: r.rating.definition,
        comment: r.comment,
        isError: r.isError,
        ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
      })),
    };
  },
});

/**
 * foreachステップの最大並行実行数
 * AI APIへのリクエスト負荷とNode.jsのイベントループ負荷のバランスを考慮して設定。
 * グループ数がこの値を超える場合はキューイングされる。
 */
const FOREACH_CONCURRENCY = 5;

/**
 * レビューワークフロー
 *
 * 処理フロー:
 * 1. チェックリスト分割ステップ: チェック項目群をconcurrentReviewCountに基づいて分割
 * 2. map: 分割結果をforeach用の配列形式に変換
 * 3. foreach（レビュー実行ステップ）: 各グループに対してレビューを実行
 * 4. map: 全グループのレビュー結果をフラット化
 */
export const reviewWorkflow = createWorkflow({
  id: 'review-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  requestContextSchema,
});

reviewWorkflow
  .then(checklistSplitStep)
  .map(async ({ inputData }) => {
    // 分割結果をforeach用の配列形式に変換
    const groups = inputData.groups;
    return groups.map((group) => ({ items: group }));
  })
  .foreach(reviewExecutionStep, { concurrency: FOREACH_CONCURRENCY })
  .map(async ({ inputData }) => {
    // 全グループのレビュー結果をフラット化
    const allResults = inputData.flatMap((group) => group.results);
    return { results: allResults };
  })
  .commit();
