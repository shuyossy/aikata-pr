import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { CheckItem } from '../../../domain/checkItem/index.js';
import { Checklist } from '../../../domain/checklist/index.js';

/**
 * AI分割結果のスキーマ
 */
const aiSplitOutputSchema = z.object({
  groups: z.array(z.array(z.string())),
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
}

/**
 * チェックリストをconcurrentReviewCountに基づいて分割する
 *
 * - concurrentReviewCount=1: 各項目を個別グループに
 * - concurrentReviewCount>=総項目数: 全項目を1グループに
 * - それ以外: AI分割を試み、失敗時は機械的分割にフォールバック
 */
export async function splitChecklist(
  items: CheckItem[],
  concurrentReviewCount: number,
  agentContext: AgentContext | null,
): Promise<CheckItem[][]> {
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
 */
async function callAgent(
  agentContext: AgentContext,
  items: CheckItem[],
  concurrentReviewCount: number,
): Promise<CheckItem[][]> {
  const itemTexts = items.map((item, index) => `${index + 1}. ${item.content}`).join('\n');

  const result = await agentContext.agent.generate(
    `Group the following check items into groups of approximately ${concurrentReviewCount} items each:\n\n${itemTexts}`,
    {
      structuredOutput: { schema: aiSplitOutputSchema },
      requestContext: agentContext.requestContext,
    },
  );

  // AI出力のグループ(string[][])をCheckItem[][]に変換
  const resultObject = (result as { object: { groups: string[][] } }).object;
  const contentToItem = buildContentToItemMap(items);

  return resultObject.groups.map((group) =>
    group
      .map((content) => contentToItem.get(content))
      .filter((item): item is CheckItem => item !== undefined),
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
  groups: CheckItem[][],
  allItems: CheckItem[],
  count: number,
): CheckItem[][] {
  const validContents = new Set(allItems.map((item) => item.content));

  // 1. フラット化して重複除去（最初の出現を保持）、無効な項目を除去
  const seen = new Set<string>();
  const cleanedGroups: CheckItem[][] = [];

  for (const group of groups) {
    const cleanedGroup: CheckItem[] = [];
    for (const item of group) {
      if (validContents.has(item.content) && !seen.has(item.content)) {
        seen.add(item.content);
        cleanedGroup.push(item);
      }
    }
    if (cleanedGroup.length > 0) {
      cleanedGroups.push(cleanedGroup);
    }
  }

  // 2. 漏れた項目をプールに追加
  const pool: CheckItem[] = [];
  for (const item of allItems) {
    if (!seen.has(item.content)) {
      pool.push(item);
    }
  }

  // 3. concurrentReviewCountを超えるグループを分割
  const splitGroups: CheckItem[][] = [];
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
    const newGroup: CheckItem[] = [];
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
function mergeUndersizedGroups(groups: CheckItem[][], count: number): CheckItem[][] {
  if (groups.length <= 1) {
    return groups;
  }

  return mechanicalSplit(groups.flat(), count);
}

/**
 * 機械的分割: Checklist.splitByCount()を利用
 */
function mechanicalSplit(items: CheckItem[], count: number): CheckItem[][] {
  const checklist = new Checklist(items);
  return checklist.splitByCount(count);
}

/**
 * CheckItem配列からcontent→CheckItemのMapを構築する
 */
function buildContentToItemMap(items: CheckItem[]): Map<string, CheckItem> {
  const map = new Map<string, CheckItem>();
  for (const item of items) {
    map.set(item.content, item);
  }
  return map;
}
