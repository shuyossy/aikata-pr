import * as fs from 'node:fs';
import type { MastraLanguageModel } from '@mastra/core/agent';
import { CheckItem } from '../../../domain/checkItem/index.js';
import { ReviewResult } from '../../../domain/reviewResult/index.js';
import { Rating } from '../../../domain/rating/index.js';
import { MrContext } from '../../../domain/mrContext/index.js';
import { PriorReviewContext } from '../../../domain/priorReviewContext/index.js';
import { createReviewAgent } from '../../agents/reviewAgent.js';

/**
 * レビュー実行ステップの設定
 */
export interface ReviewExecutionConfig {
  checkItems: CheckItem[];
  model: MastraLanguageModel;
  ratings: Rating[];
  commentFormat: string;
  additionalInstructions: string;
  mrContext: MrContext;
  priorReviewContext: PriorReviewContext | null;
  resultFilePath: string;
}

/**
 * 結果ファイルに保存されるレビュー結果の形式
 */
interface StoredReviewResult {
  checkItemContent: string;
  ratingLabel: string;
  ratingDefinition: string;
  comment: string;
  isError: boolean;
  errorMessage?: string;
}

/**
 * リトライの最大回数
 */
const MAX_RETRIES = 2;

/**
 * 結果ファイルからレビュー結果を読み込む
 */
function readResultsFromFile(filePath: string): StoredReviewResult[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as StoredReviewResult[];
}

/**
 * レビュー実行のコアロジック
 *
 * レビューエージェントを作成し、チェック項目のレビューを実行する。
 * 結果はエージェントがstoreReviewResultツールを使ってファイルに保存する。
 * 漏れがある場合は最大2回リトライし、それでも漏れがある場合はエラー結果を返す。
 */
export async function executeReview(config: ReviewExecutionConfig): Promise<ReviewResult[]> {
  const { checkItems, resultFilePath } = config;

  // レビューエージェントを作成
  const agent = createReviewAgent({
    model: config.model,
    checkItems: checkItems.map((item) => item.content),
    ratings: config.ratings.map((r) => ({ label: r.label, definition: r.definition })),
    commentFormat: config.commentFormat,
    additionalInstructions: config.additionalInstructions,
    mrContext: {
      title: config.mrContext.title,
      description: config.mrContext.description,
      sourceBranch: config.mrContext.sourceBranch,
      targetBranch: config.mrContext.targetBranch,
      diff: config.mrContext.diff,
    },
    priorReviewContext: config.priorReviewContext
      ? {
          results: config.priorReviewContext.results.map((r) => ({
            checkItemContent: r.checkItem.content,
            ratingLabel: r.rating.label,
            comment: r.comment,
          })),
          commitMessages: config.priorReviewContext.commitMessages,
          diffSincePrior: config.priorReviewContext.diffSincePrior,
        }
      : null,
  });

  // 初回のエージェント実行
  const prompt = `Review all ${checkItems.length} check items and store results using the storeReviewResult tool. The result file path is: ${resultFilePath}`;

  try {
    await agent.generate(prompt);
  } catch (error) {
    // 初回Agent失敗時は全項目をエラー結果として返す
    const errorMessage = error instanceof Error ? error.message : 'Agent execution failed';
    return checkItems.map((item) => ReviewResult.error(item, errorMessage));
  }

  // 漏れチェックとリトライ
  let storedResults = readResultsFromFile(resultFilePath);

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    const missingItems = checkItems.filter(
      (item) => !storedResults.some((r) => r.checkItemContent === item.content),
    );

    if (missingItems.length === 0) {
      break;
    }

    // 漏れた項目についてリトライ
    try {
      const retryPrompt = `The following check items are still missing results. Please review them and store results using the storeReviewResult tool:\n${missingItems.map((i) => `- ${i.content}`).join('\n')}\nResult file path: ${resultFilePath}`;
      await agent.generate(retryPrompt);
      storedResults = readResultsFromFile(resultFilePath);
    } catch {
      // リトライ失敗時は次のリトライへ（または終了）
      break;
    }
  }

  // 結果をReviewResultに変換
  return checkItems.map((item) => {
    const stored = storedResults.find((r) => r.checkItemContent === item.content);
    if (!stored) {
      return ReviewResult.error(item, 'Review result not found after agent execution');
    }
    if (stored.isError) {
      return ReviewResult.error(item, stored.errorMessage ?? 'Unknown error');
    }
    return ReviewResult.success(
      item,
      new Rating(stored.ratingLabel, stored.ratingDefinition),
      stored.comment,
    );
  });
}
