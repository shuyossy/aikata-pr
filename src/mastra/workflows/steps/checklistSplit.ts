import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';
import { withRateLimitRetry, type RateLimitRetryConfig } from '../../../lib/rateLimitRetry.js';
import { buildGenerateOptions, type WorkflowRequestContext } from '../../requestContext.js';

/**
 * AI分割結果のスキーマ（ID番号のグループ）
 */
const aiSplitOutputSchema = z.object({
  groups: z.array(z.array(z.number())),
});

/**
 * Agent呼び出し時に渡すコンテキスト
 *
 * Agentのジェネリクス型がRequestContext型に依存し、
 * 呼び出し元で異なる型パラメータのAgentが使われるため、
 * ここでは汎用的な型を受け入れる。
 */
export interface AgentContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: Agent<string, Record<string, any>, any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestContext: RequestContext<any>;
  rateLimitRetryConfig: RateLimitRetryConfig;
}

/**
 * チェックリストをconcurrentReviewCountに基づいて分割する
 *
 * - concurrentReviewCount=null: 全項目を1グループに（分割なし）
 * - concurrentReviewCount=1: 各項目を個別グループに
 * - concurrentReviewCount>=総項目数: 全項目を1グループに
 * - それ以外: AI分割を試み、失敗時は機械的分割にフォールバック
 */
export async function splitChecklist(
  items: IndexedCheckItem[],
  concurrentReviewCount: number | null,
  agentContext: AgentContext | null,
): Promise<IndexedCheckItem[][]> {
  // 分割なし（nullの場合は全項目を1グループに）
  if (concurrentReviewCount === null) {
    return [[...items]];
  }

  if (concurrentReviewCount === 1) {
    return items.map((item) => [item]);
  }

  if (concurrentReviewCount >= items.length) {
    return [[...items]];
  }

  if (agentContext === null) {
    return mechanicalSplit(items, concurrentReviewCount);
  }

  // AI分割を試行
  try {
    const aiGroups = await callAgent(agentContext, items, concurrentReviewCount);
    const adjusted = adjustGroups(aiGroups, items, concurrentReviewCount);
    return adjusted;
  } catch {
    // AI分割失敗時は機械的分割にフォールバック
    return mechanicalSplit(items, concurrentReviewCount);
  }
}

/**
 * Agentを呼び出してチェック項目をグルーピングする
 * AIにはIDと内容を[ID: N]形式で提示し、IDのグループを返させる
 */
async function callAgent(
  agentContext: AgentContext,
  items: IndexedCheckItem[],
  concurrentReviewCount: number,
): Promise<IndexedCheckItem[][]> {
  const itemTexts = items.map((item) => `[ID: ${item.id}] ${item.content}`).join('\n');

  const result = await withRateLimitRetry(
    () =>
      agentContext.agent.generate(
        `Group the following check items into groups of approximately ${concurrentReviewCount} items each. Return the item IDs (the numbers shown in [ID: N]) grouped together:\n\n${itemTexts}`,
        {
          structuredOutput: { schema: aiSplitOutputSchema },
          requestContext: agentContext.requestContext,
          ...buildGenerateOptions(agentContext.requestContext.all as WorkflowRequestContext),
        },
      ),
    agentContext.rateLimitRetryConfig,
  );

  // AI出力のグループ(number[][])をIndexedCheckItem[][]に変換
  const resultObject = (result as { object: { groups: number[][] } }).object;
  const idToItem = buildIdToItemMap(items);

  return resultObject.groups.map((group) =>
    group
      .map((id) => idToItem.get(id))
      .filter((item): item is IndexedCheckItem => item !== undefined),
  );
}

/**
 * AI分割結果を調整して正しいグルーピングにする
 *
 * 1. 全グループをフラット化し、重複を除去（最初の出現を保持）
 * 2. 漏れた項目を検出してプールに追加
 * 3. allItemsに存在しない項目を除去
 * 4. concurrentReviewCountを超えるグループを分割
 * 5. プール内の項目を配分（未満グループを埋めてから新グループ作成）
 * 6. 最後のグループ以外がconcurrentReviewCount未満にならないように統合
 */
export function adjustGroups(
  groups: IndexedCheckItem[][],
  allItems: IndexedCheckItem[],
  count: number,
): IndexedCheckItem[][] {
  const validIds = new Set(allItems.map((item) => item.id));

  // 1. フラット化して重複除去（最初の出現を保持）、無効な項目を除去
  const seen = new Set<number>();
  const cleanedGroups: IndexedCheckItem[][] = [];

  for (const group of groups) {
    const cleanedGroup: IndexedCheckItem[] = [];
    for (const item of group) {
      if (validIds.has(item.id) && !seen.has(item.id)) {
        seen.add(item.id);
        cleanedGroup.push(item);
      }
    }
    if (cleanedGroup.length > 0) {
      cleanedGroups.push(cleanedGroup);
    }
  }

  // 2. 漏れた項目をプールに追加
  const pool: IndexedCheckItem[] = [];
  for (const item of allItems) {
    if (!seen.has(item.id)) {
      pool.push(item);
    }
  }

  // 3. concurrentReviewCountを超えるグループを分割
  const splitGroups: IndexedCheckItem[][] = [];
  for (const group of cleanedGroups) {
    if (group.length <= count) {
      splitGroups.push(group);
    } else {
      // countごとに分割
      for (let i = 0; i < group.length; i += count) {
        splitGroups.push(group.slice(i, i + count));
      }
    }
  }

  // 4. プール内の項目を配分: 未満グループを埋めてから新グループ作成
  let poolIndex = 0;
  for (const group of splitGroups) {
    while (group.length < count && poolIndex < pool.length) {
      group.push(pool[poolIndex]);
      poolIndex++;
    }
  }
  // 残りのプール項目は新グループとして追加
  while (poolIndex < pool.length) {
    const newGroup: IndexedCheckItem[] = [];
    while (newGroup.length < count && poolIndex < pool.length) {
      newGroup.push(pool[poolIndex]);
      poolIndex++;
    }
    splitGroups.push(newGroup);
  }

  // 5. 最後のグループ以外がcount未満にならないように統合
  return mergeUndersizedGroups(splitGroups, count);
}

/**
 * count未満のグループを統合して、最後のグループのみcount未満を許容する
 */
function mergeUndersizedGroups(groups: IndexedCheckItem[][], count: number): IndexedCheckItem[][] {
  if (groups.length <= 1) {
    return groups;
  }

  return mechanicalSplit(groups.flat(), count);
}

/**
 * 機械的分割: 元のIDを保持したまま指定数ごとに分割する
 */
function mechanicalSplit(items: IndexedCheckItem[], count: number): IndexedCheckItem[][] {
  if (count <= 0) {
    throw new Error('count must be greater than 0');
  }
  const groups: IndexedCheckItem[][] = [];
  for (let i = 0; i < items.length; i += count) {
    groups.push(items.slice(i, i + count));
  }
  return groups;
}

/**
 * IndexedCheckItem配列からid→IndexedCheckItemのMapを構築する
 */
function buildIdToItemMap(items: IndexedCheckItem[]): Map<number, IndexedCheckItem> {
  const map = new Map<number, IndexedCheckItem>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}
