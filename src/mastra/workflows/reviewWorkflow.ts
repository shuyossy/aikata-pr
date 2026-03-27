import { createWorkflow, createStep } from '@mastra/core/workflows';
import type { MastraLanguageModel } from '@mastra/core/agent';
import { z } from 'zod';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { splitChecklist } from './steps/checklistSplitStep.js';
import { executeReview } from './steps/reviewExecutionStep.js';
import { createChecklistSplitAgent } from '../agents/checklistSplitAgent.js';
import { CheckItem } from '../../domain/checkItem/index.js';
import { Rating } from '../../domain/rating/index.js';
import { MrContext } from '../../domain/mrContext/index.js';
import { PriorReviewContext } from '../../domain/priorReviewContext/index.js';
import { ReviewResult } from '../../domain/reviewResult/index.js';

/**
 * レビュー結果のZodスキーマ
 */
const reviewResultSchema = z.object({
  checkItemContent: z.string(),
  ratingLabel: z.string(),
  ratingDefinition: z.string(),
  comment: z.string(),
  isError: z.boolean(),
  errorMessage: z.string().optional(),
});

/**
 * ワークフロー入力スキーマ
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
  userId: z.string(),
  aiApiKey: z.string(),
  aiApiEndpointUrl: z.string(),
  aiModelName: z.string(),
  skillsPaths: z.array(z.string()),
  resultFilePath: z.string(),
});

/**
 * ワークフロー出力スキーマ
 */
const workflowOutputSchema = z.object({
  results: z.array(reviewResultSchema),
});

/**
 * ユーザIDに基づいてAIモデルを動的に作成するヘルパー関数
 *
 * createOpenAICompatibleが返すLanguageModelV3をMastraLanguageModelとしてキャストする。
 * AgentコンストラクタはMastraModelConfig（LanguageModelV3を含む）を受け入れるが、
 * ファクトリ関数のシグネチャがMastraLanguageModelを要求するためキャストが必要。
 */
function createModel(
  userId: string,
  apiKey: string,
  baseURL: string,
  modelName: string,
): MastraLanguageModel {
  return createOpenAICompatible({
    name: userId,
    apiKey,
    baseURL,
  }).chatModel(modelName) as unknown as MastraLanguageModel;
}

/**
 * Step 1: チェックリスト分割ステップ
 * チェックリストをconcurrentReviewCountに基づいて分割する
 */
const checklistSplitStep = createStep({
  id: 'checklist-split',
  description: 'チェックリストをconcurrentReviewCountに基づいて分割する',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({
    groups: z.array(z.array(z.string())),
  }),
  execute: async ({ inputData }) => {
    const items = inputData.checkItemContents.map((c) => new CheckItem(c));
    const model = createModel(
      inputData.userId,
      inputData.aiApiKey,
      inputData.aiApiEndpointUrl,
      inputData.aiModelName,
    );

    // concurrentReviewCountが2以上かつ総チェック項目数より少ない場合はAI分割を実行
    const needsAiSplit =
      inputData.concurrentReviewCount > 1 && inputData.concurrentReviewCount < items.length;
    const agent = needsAiSplit ? createChecklistSplitAgent(model) : null;

    const groups = await splitChecklist(items, inputData.concurrentReviewCount, agent);
    return {
      groups: groups.map((group) => group.map((item) => item.content)),
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
    items: z.array(z.string()),
  }),
  outputSchema: z.object({
    results: z.array(reviewResultSchema),
  }),
  execute: async ({ inputData, getInitData }) => {
    const initData = getInitData<typeof reviewWorkflow>();
    const checkItems = inputData.items.map((c) => new CheckItem(c));
    const model = createModel(
      initData.userId,
      initData.aiApiKey,
      initData.aiApiEndpointUrl,
      initData.aiModelName,
    );
    const ratings = initData.ratings.map((r) => new Rating(r.label, r.definition));

    const mrContext = new MrContext({
      title: initData.mrTitle,
      description: initData.mrDescription,
      sourceBranch: initData.mrSourceBranch,
      targetBranch: initData.mrTargetBranch,
      diff: initData.mrDiff,
      commitHash: initData.mrCommitHash,
    });

    let priorReviewContext: PriorReviewContext | null = null;
    if (
      initData.priorReviewResults &&
      initData.priorCommitMessages &&
      initData.priorDiffSincePrior
    ) {
      priorReviewContext = new PriorReviewContext({
        results: initData.priorReviewResults.map((r) =>
          ReviewResult.success(
            new CheckItem(r.checkItemContent),
            new Rating(r.ratingLabel, r.ratingDefinition),
            r.comment,
          ),
        ),
        commitMessages: initData.priorCommitMessages,
        diffSincePrior: initData.priorDiffSincePrior,
      });
    }

    const results = await executeReview({
      checkItems,
      model,
      ratings,
      commentFormat: initData.commentFormat,
      additionalInstructions: initData.additionalInstructions,
      mrContext,
      priorReviewContext,
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
});

reviewWorkflow
  .then(checklistSplitStep)
  .map(async ({ inputData }) => {
    // 分割結果をforeach用の配列形式に変換
    const groups = inputData.groups;
    return groups.map((group) => ({ items: group }));
  })
  .foreach(reviewExecutionStep, { concurrency: 5 })
  .map(async ({ inputData }) => {
    // 全グループのレビュー結果をフラット化
    const allResults = inputData.flatMap((group) => group.results);
    return { results: allResults };
  })
  .commit();
