import * as fs from 'node:fs';
import type { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { CheckItem } from '../../../domain/checkItem/index.js';
import { ReviewResult } from '../../../domain/reviewResult/index.js';
import { Rating } from '../../../domain/rating/index.js';
import type { ReviewAgentRequestContext } from '../../requestContext.js';

/**
 * レビュー実行ステップの設定
 *
 * ratings, commentFormat, additionalInstructions, mrContext, priorReviewContext は
 * RequestContext経由でAgentに渡されるため、このConfigには含めない。
 */
export interface ReviewExecutionConfig {
  checkItems: CheckItem[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Agent<string, Record<string, any>, any, any>;
  requestContext: RequestContext<ReviewAgentRequestContext>;
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
 * シングルトンのレビューエージェントにRequestContextを渡してレビューを実行する。
 * 結果はエージェントがstoreReviewResultツールを使ってファイルに保存する。
 * 漏れがある場合は最大2回リトライし、それでも漏れがある場合はエラー結果を返す。
 */
export async function executeReview(config: ReviewExecutionConfig): Promise<ReviewResult[]> {
  const { checkItems, agent, requestContext, resultFilePath } = config;

  // 初回のエージェント実行
  const prompt = `Review all ${checkItems.length} check items and store results using the storeReviewResult tool. The result file path is: ${resultFilePath}`;

  try {
    await agent.generate(prompt, { requestContext });
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
      await agent.generate(retryPrompt, { requestContext });
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
