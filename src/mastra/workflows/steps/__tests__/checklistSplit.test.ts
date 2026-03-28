import { describe, it, expect, vi } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { IndexedChecklist } from '../../../indexedCheckItem.js';
import type { IndexedCheckItem } from '../../../indexedCheckItem.js';
import { splitChecklist, adjustGroups } from '../checklistSplit.js';
import type { AgentContext } from '../checklistSplit.js';
import type { Agent } from '@mastra/core/agent';

/**
 * Agent.generate() のモックを作成するヘルパー
 * ID方式ではAIがID番号のグループを返す
 */
function createMockAgent(
  generateFn: (prompt: string, options: unknown) => Promise<{ object: { groups: number[][] } }>,
): Agent {
  return {
    generate: generateFn,
  } as unknown as Agent;
}

/**
 * テスト用のRequestContextを作成するヘルパー
 */
function createMockRequestContext(): RequestContext {
  return new RequestContext([
    ['userId', 'test-user'],
    ['aiApiKey', 'test-key'],
    ['aiApiEndpointUrl', 'http://localhost'],
    ['aiModelName', 'test-model'],
  ]);
}

/**
 * テスト用のAgentContextを作成するヘルパー
 */
function createMockAgentContext(
  generateFn: (prompt: string, options: unknown) => Promise<{ object: { groups: number[][] } }>,
): AgentContext {
  return {
    agent: createMockAgent(generateFn),
    requestContext: createMockRequestContext(),
  };
}

describe('splitChecklist', () => {
  // テスト用のIndexedCheckItem配列を生成するヘルパー
  const makeItems = (contents: string[]): IndexedCheckItem[] =>
    new IndexedChecklist(contents).items.slice();

  describe('AI不使用のケース', () => {
    it('concurrentReviewCount=1の場合、各項目が個別グループになる', async () => {
      const items = makeItems(['item1', 'item2', 'item3']);

      const result = await splitChecklist(items, 1, null);

      expect(result).toHaveLength(3);
      expect(result[0]).toHaveLength(1);
      expect(result[0][0]).toEqual({ id: 1, content: 'item1' });
      expect(result[1][0]).toEqual({ id: 2, content: 'item2' });
      expect(result[2][0]).toEqual({ id: 3, content: 'item3' });
    });

    it('concurrentReviewCount>=総項目数の場合、全項目が1グループになる', async () => {
      const items = makeItems(['item1', 'item2', 'item3']);

      const result = await splitChecklist(items, 3, null);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(3);
      expect(result[0].map((i) => i.content)).toEqual(['item1', 'item2', 'item3']);
    });

    it('concurrentReviewCount>総項目数の場合も全項目が1グループになる', async () => {
      const items = makeItems(['item1', 'item2']);

      const result = await splitChecklist(items, 10, null);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(2);
    });

    it('agentContextがnullの場合、機械的分割にフォールバックする', async () => {
      const items = makeItems(['a', 'b', 'c', 'd', 'e']);

      const result = await splitChecklist(items, 2, null);

      // splitByCount(2) で 3グループ: [a,b], [c,d], [e]
      expect(result).toHaveLength(3);
      expect(result[0].map((i) => i.content)).toEqual(['a', 'b']);
      expect(result[1].map((i) => i.content)).toEqual(['c', 'd']);
      expect(result[2].map((i) => i.content)).toEqual(['e']);
    });

    it('機械的分割でもIDが保持される', async () => {
      const items = makeItems(['a', 'b', 'c', 'd', 'e']);

      const result = await splitChecklist(items, 2, null);

      const allIds = result.flat().map((i) => i.id);
      expect(allIds).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('AI分割が成功するケース', () => {
    it('AI分割結果が正しい場合はそのまま返す', async () => {
      const items = makeItems(['security check', 'auth check', 'perf check', 'load test']);
      // AIはID番号でグループを返す
      const agentContext = createMockAgentContext(async () => ({
        object: {
          groups: [
            [1, 2],
            [3, 4],
          ],
        },
      }));

      const result = await splitChecklist(items, 2, agentContext);

      expect(result).toHaveLength(2);
      expect(result[0].map((i) => i.content)).toEqual(['security check', 'auth check']);
      expect(result[1].map((i) => i.content)).toEqual(['perf check', 'load test']);
    });

    it('AI分割結果に漏れがある場合、漏れた項目が補完される', async () => {
      const items = makeItems(['item1', 'item2', 'item3', 'item4']);
      // AIが ID:3 を漏らしている
      const agentContext = createMockAgentContext(async () => ({
        object: {
          groups: [[1, 2], [4]],
        },
      }));

      const result = await splitChecklist(items, 2, agentContext);

      // 全項目が含まれていること
      const allIds = result
        .flat()
        .map((i) => i.id)
        .sort();
      expect(allIds).toEqual([1, 2, 3, 4]);
    });

    it('AI分割結果に重複がある場合、重複が除去される', async () => {
      const items = makeItems(['item1', 'item2', 'item3', 'item4']);
      // AIが ID:2 を重複して返している
      const agentContext = createMockAgentContext(async () => ({
        object: {
          groups: [[1, 2], [2, 3], [4]],
        },
      }));

      const result = await splitChecklist(items, 2, agentContext);

      // 全項目が過不足なく含まれていること
      const allIds = result
        .flat()
        .map((i) => i.id)
        .sort();
      expect(allIds).toEqual([1, 2, 3, 4]);
      // 重複がないこと
      const uniqueIds = [...new Set(allIds)];
      expect(uniqueIds).toHaveLength(4);
    });

    it('AI分割結果でグループサイズがconcurrentReviewCountを超過する場合、再分割される', async () => {
      const items = makeItems(['a', 'b', 'c', 'd', 'e', 'f']);
      // AIが1グループに4項目入れてしまっている（concurrentReviewCount=2を超過）
      const agentContext = createMockAgentContext(async () => ({
        object: {
          groups: [
            [1, 2, 3, 4],
            [5, 6],
          ],
        },
      }));

      const result = await splitChecklist(items, 2, agentContext);

      // 各グループがconcurrentReviewCount以下であること
      for (const group of result) {
        expect(group.length).toBeLessThanOrEqual(2);
      }
      // 全項目が含まれていること
      const allIds = result
        .flat()
        .map((i) => i.id)
        .sort();
      expect(allIds).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('最終的にconcurrentReviewCount未満のグループは最後の1つだけ', async () => {
      const items = makeItems(['a', 'b', 'c', 'd', 'e']);
      // AIが不均等に分割（1項目のグループが複数ある）
      const agentContext = createMockAgentContext(async () => ({
        object: {
          groups: [[1, 2], [3], [4], [5]],
        },
      }));

      const result = await splitChecklist(items, 2, agentContext);

      // concurrentReviewCount未満のグループは最後の1つだけ
      const undersizedGroups = result.filter((g) => g.length < 2);
      if (undersizedGroups.length > 0) {
        expect(undersizedGroups).toHaveLength(1);
        expect(result[result.length - 1].length).toBeLessThanOrEqual(2);
        for (let i = 0; i < result.length - 1; i++) {
          expect(result[i].length).toBe(2);
        }
      }
      // 全項目が含まれていること
      const allIds = result
        .flat()
        .map((i) => i.id)
        .sort();
      expect(allIds).toEqual([1, 2, 3, 4, 5]);
    });

    it('agent.generate()にrequestContextが渡されること', async () => {
      const items = makeItems(['security check', 'auth check', 'perf check', 'load test']);
      const requestContext = createMockRequestContext();
      const generateFn = vi.fn().mockResolvedValue({
        object: {
          groups: [
            [1, 2],
            [3, 4],
          ],
        },
      });
      const agentContext: AgentContext = {
        agent: createMockAgent(generateFn),
        requestContext,
      };

      await splitChecklist(items, 2, agentContext);

      // generate()にrequestContextが渡されていること
      expect(generateFn).toHaveBeenCalledTimes(1);
      const callOptions = generateFn.mock.calls[0][1];
      expect(callOptions.requestContext).toBe(requestContext);
    });

    it('プロンプトに[ID: N]形式でチェック項目が含まれる', async () => {
      const items = makeItems(['security check', 'auth check', 'perf check']);
      const generateFn = vi.fn().mockResolvedValue({
        object: { groups: [[1, 2], [3]] },
      });
      const agentContext: AgentContext = {
        agent: createMockAgent(generateFn),
        requestContext: createMockRequestContext(),
      };

      await splitChecklist(items, 2, agentContext);

      const prompt = generateFn.mock.calls[0][0] as string;
      expect(prompt).toContain('[ID: 1] security check');
      expect(prompt).toContain('[ID: 2] auth check');
      expect(prompt).toContain('[ID: 3] perf check');
    });
  });

  describe('AI分割が失敗するケース', () => {
    it('AI分割が例外をスローした場合、機械的分割にフォールバックする', async () => {
      const items = makeItems(['x', 'y', 'z', 'w']);
      const agentContext = createMockAgentContext(async () => {
        throw new Error('AI API error');
      });

      const result = await splitChecklist(items, 2, agentContext);

      // 機械的分割の結果になること: [x,y], [z,w]
      expect(result).toHaveLength(2);
      expect(result[0].map((i) => i.content)).toEqual(['x', 'y']);
      expect(result[1].map((i) => i.content)).toEqual(['z', 'w']);
    });
  });

  describe('エッジケース', () => {
    it('AI分割結果にallItemsに存在しないIDがある場合、除去される', async () => {
      const items = makeItems(['item1', 'item2', 'item3', 'item4']);
      // AIが存在しないID 99 を含めている
      const agentContext = createMockAgentContext(async () => ({
        object: {
          groups: [[1, 99], [2, 3], [4]],
        },
      }));

      const result = await splitChecklist(items, 2, agentContext);

      // 全項目が過不足なく含まれていること（ID:99は除外）
      const allIds = result
        .flat()
        .map((i) => i.id)
        .sort();
      expect(allIds).toEqual([1, 2, 3, 4]);
    });

    it('concurrentReviewCountが1の場合はagentContextが渡されてもAI不使用', async () => {
      const items = makeItems(['a', 'b']);
      const agentContext = createMockAgentContext(async () => ({
        object: { groups: [[1, 2]] },
      }));
      const generateSpy = vi.spyOn(agentContext.agent, 'generate');

      const result = await splitChecklist(items, 1, agentContext);

      // agentが呼ばれないこと
      expect(generateSpy).not.toHaveBeenCalled();
      // 各項目が個別グループ
      expect(result).toHaveLength(2);
      expect(result[0][0]).toEqual({ id: 1, content: 'a' });
      expect(result[1][0]).toEqual({ id: 2, content: 'b' });
    });

    it('concurrentReviewCount>=総項目数の場合はagentContextが渡されてもAI不使用', async () => {
      const items = makeItems(['a', 'b']);
      const agentContext = createMockAgentContext(async () => ({
        object: { groups: [[1], [2]] },
      }));
      const generateSpy = vi.spyOn(agentContext.agent, 'generate');

      const result = await splitChecklist(items, 5, agentContext);

      expect(generateSpy).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(2);
    });
  });

  describe('adjustGroups', () => {
    it('漏れた項目がプール内に残り、既存グループを埋めた後に新グループとして追加される', () => {
      // allItemsに6項目あるが、groupsには2項目しかない（4項目が漏れ）
      const allItems = makeItems(['a', 'b', 'c', 'd', 'e', 'f']);
      // groupsには2項目のみ
      const groups = [allItems.slice(0, 2)]; // [id:1, id:2]

      const result = adjustGroups(groups, allItems, 2);

      // 全項目が含まれていること
      const allIds = result
        .flat()
        .map((i) => i.id)
        .sort();
      expect(allIds).toEqual([1, 2, 3, 4, 5, 6]);
      // 各グループがcount以下であること
      for (const group of result) {
        expect(group.length).toBeLessThanOrEqual(2);
      }
    });

    it('グループが1つ以下の場合、mergeUndersizedGroupsでそのまま返される', () => {
      const allItems = makeItems(['a']);
      const groups = [allItems.slice()];

      const result = adjustGroups(groups, allItems, 2);

      expect(result).toHaveLength(1);
      expect(result[0].map((i) => i.content)).toEqual(['a']);
    });

    it('空のグループの場合も正しく処理される', () => {
      const allItems = makeItems(['a', 'b', 'c']);
      // 空のグループ（全項目がプールに入る）
      const groups: IndexedCheckItem[][] = [];

      const result = adjustGroups(groups, allItems, 2);

      // 全項目が含まれていること
      const allIds = result
        .flat()
        .map((i) => i.id)
        .sort();
      expect(allIds).toEqual([1, 2, 3]);
    });
  });
});
