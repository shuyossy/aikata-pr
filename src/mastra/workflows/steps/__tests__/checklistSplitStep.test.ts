import { describe, it, expect, vi } from 'vitest';
import { CheckItem } from '../../../../domain/checkItem/index.js';
import { splitChecklist, adjustGroups } from '../checklistSplitStep.js';
import type { Agent } from '@mastra/core/agent';

/**
 * Agent.generate() のモックを作成するヘルパー
 * Mastra の Agent.generate() は structuredOutput 指定時に { object: T } を返す
 */
function createMockAgent(
  generateFn: (prompt: string, options: unknown) => Promise<{ object: { groups: string[][] } }>,
): Agent {
  return {
    generate: generateFn,
  } as unknown as Agent;
}

describe('splitChecklist', () => {
  // テスト用のチェック項目を生成するヘルパー
  const makeItems = (contents: string[]): CheckItem[] => contents.map((c) => new CheckItem(c));

  describe('AI不使用のケース', () => {
    it('concurrentReviewCount=1の場合、各項目が個別グループになる', async () => {
      const items = makeItems(['item1', 'item2', 'item3']);

      const result = await splitChecklist(items, 1, null);

      expect(result).toHaveLength(3);
      expect(result[0]).toHaveLength(1);
      expect(result[0][0].content).toBe('item1');
      expect(result[1]).toHaveLength(1);
      expect(result[1][0].content).toBe('item2');
      expect(result[2]).toHaveLength(1);
      expect(result[2][0].content).toBe('item3');
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

    it('agentがnullの場合、機械的分割にフォールバックする', async () => {
      const items = makeItems(['a', 'b', 'c', 'd', 'e']);

      const result = await splitChecklist(items, 2, null);

      // Checklist.splitByCount(2) で 3グループ: [a,b], [c,d], [e]
      expect(result).toHaveLength(3);
      expect(result[0].map((i) => i.content)).toEqual(['a', 'b']);
      expect(result[1].map((i) => i.content)).toEqual(['c', 'd']);
      expect(result[2].map((i) => i.content)).toEqual(['e']);
    });
  });

  describe('AI分割が成功するケース', () => {
    it('AI分割結果が正しい場合はそのまま返す', async () => {
      const items = makeItems(['security check', 'auth check', 'perf check', 'load test']);
      const agent = createMockAgent(async () => ({
        object: {
          groups: [
            ['security check', 'auth check'],
            ['perf check', 'load test'],
          ],
        },
      }));

      const result = await splitChecklist(items, 2, agent);

      expect(result).toHaveLength(2);
      expect(result[0].map((i) => i.content)).toEqual(['security check', 'auth check']);
      expect(result[1].map((i) => i.content)).toEqual(['perf check', 'load test']);
    });

    it('AI分割結果に漏れがある場合、漏れた項目が補完される', async () => {
      const items = makeItems(['item1', 'item2', 'item3', 'item4']);
      // AIが item3 を漏らしている
      const agent = createMockAgent(async () => ({
        object: {
          groups: [['item1', 'item2'], ['item4']],
        },
      }));

      const result = await splitChecklist(items, 2, agent);

      // 全項目が含まれていること
      const allContents = result
        .flat()
        .map((i) => i.content)
        .sort();
      expect(allContents).toEqual(['item1', 'item2', 'item3', 'item4']);
    });

    it('AI分割結果に重複がある場合、重複が除去される', async () => {
      const items = makeItems(['item1', 'item2', 'item3', 'item4']);
      // AIが item2 を重複して返している
      const agent = createMockAgent(async () => ({
        object: {
          groups: [['item1', 'item2'], ['item2', 'item3'], ['item4']],
        },
      }));

      const result = await splitChecklist(items, 2, agent);

      // 全項目が過不足なく含まれていること
      const allContents = result
        .flat()
        .map((i) => i.content)
        .sort();
      expect(allContents).toEqual(['item1', 'item2', 'item3', 'item4']);
      // 重複がないこと
      const uniqueContents = [...new Set(allContents)];
      expect(uniqueContents).toHaveLength(4);
    });

    it('AI分割結果でグループサイズがconcurrentReviewCountを超過する場合、再分割される', async () => {
      const items = makeItems(['a', 'b', 'c', 'd', 'e', 'f']);
      // AIが1グループに4項目入れてしまっている（concurrentReviewCount=2を超過）
      const agent = createMockAgent(async () => ({
        object: {
          groups: [
            ['a', 'b', 'c', 'd'],
            ['e', 'f'],
          ],
        },
      }));

      const result = await splitChecklist(items, 2, agent);

      // 各グループがconcurrentReviewCount以下であること
      for (const group of result) {
        expect(group.length).toBeLessThanOrEqual(2);
      }
      // 全項目が含まれていること
      const allContents = result
        .flat()
        .map((i) => i.content)
        .sort();
      expect(allContents).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });

    it('最終的にconcurrentReviewCount未満のグループは最後の1つだけ', async () => {
      const items = makeItems(['a', 'b', 'c', 'd', 'e']);
      // AIが不均等に分割（1項目のグループが複数ある）
      const agent = createMockAgent(async () => ({
        object: {
          groups: [['a', 'b'], ['c'], ['d'], ['e']],
        },
      }));

      const result = await splitChecklist(items, 2, agent);

      // concurrentReviewCount未満のグループは最後の1つだけ
      const undersizedGroups = result.filter((g) => g.length < 2);
      if (undersizedGroups.length > 0) {
        // 最後のグループのみが未満であることを確認
        expect(undersizedGroups).toHaveLength(1);
        expect(result[result.length - 1].length).toBeLessThanOrEqual(2);
        // 最後のグループ以外は全て concurrentReviewCount であること
        for (let i = 0; i < result.length - 1; i++) {
          expect(result[i].length).toBe(2);
        }
      }
      // 全項目が含まれていること
      const allContents = result
        .flat()
        .map((i) => i.content)
        .sort();
      expect(allContents).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('AI分割が失敗するケース', () => {
    it('AI分割が例外をスローした場合、機械的分割にフォールバックする', async () => {
      const items = makeItems(['x', 'y', 'z', 'w']);
      const agent = createMockAgent(async () => {
        throw new Error('AI API error');
      });

      const result = await splitChecklist(items, 2, agent);

      // 機械的分割の結果になること: [x,y], [z,w]
      expect(result).toHaveLength(2);
      expect(result[0].map((i) => i.content)).toEqual(['x', 'y']);
      expect(result[1].map((i) => i.content)).toEqual(['z', 'w']);
    });
  });

  describe('エッジケース', () => {
    it('AI分割結果にallItemsに存在しない項目がある場合、除去される', async () => {
      const items = makeItems(['item1', 'item2', 'item3', 'item4']);
      // AIが存在しない項目 "unknown" を含めている
      const agent = createMockAgent(async () => ({
        object: {
          groups: [['item1', 'unknown'], ['item2', 'item3'], ['item4']],
        },
      }));

      const result = await splitChecklist(items, 2, agent);

      // 全項目が過不足なく含まれていること（unknownは除外）
      const allContents = result
        .flat()
        .map((i) => i.content)
        .sort();
      expect(allContents).toEqual(['item1', 'item2', 'item3', 'item4']);
    });

    it('concurrentReviewCountが1の場合はagentが渡されてもAI不使用', async () => {
      const items = makeItems(['a', 'b']);
      const agent = createMockAgent(async () => ({
        object: { groups: [['a', 'b']] },
      }));
      const generateSpy = vi.spyOn(agent, 'generate');

      const result = await splitChecklist(items, 1, agent);

      // agentが呼ばれないこと
      expect(generateSpy).not.toHaveBeenCalled();
      // 各項目が個別グループ
      expect(result).toHaveLength(2);
      expect(result[0][0].content).toBe('a');
      expect(result[1][0].content).toBe('b');
    });

    it('concurrentReviewCount>=総項目数の場合はagentが渡されてもAI不使用', async () => {
      const items = makeItems(['a', 'b']);
      const agent = createMockAgent(async () => ({
        object: { groups: [['a'], ['b']] },
      }));
      const generateSpy = vi.spyOn(agent, 'generate');

      const result = await splitChecklist(items, 5, agent);

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
      const groups = [allItems.slice(0, 2)]; // [a, b]

      const result = adjustGroups(groups, allItems, 2);

      // 全項目が含まれていること
      const allContents = result
        .flat()
        .map((i) => i.content)
        .sort();
      expect(allContents).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
      // 各グループがcount以下であること
      for (const group of result) {
        expect(group.length).toBeLessThanOrEqual(2);
      }
    });

    it('グループが1つ以下の場合、mergeUndersizedGroupsでそのまま返される', () => {
      const allItems = makeItems(['a']);
      const groups = [allItems];

      const result = adjustGroups(groups, allItems, 2);

      expect(result).toHaveLength(1);
      expect(result[0].map((i) => i.content)).toEqual(['a']);
    });

    it('空のグループの場合も正しく処理される', () => {
      const allItems = makeItems(['a', 'b', 'c']);
      // 空のグループを含む（全項目がプールに入る）
      const groups: CheckItem[][] = [];

      const result = adjustGroups(groups, allItems, 2);

      // 全項目が含まれていること
      const allContents = result
        .flat()
        .map((i) => i.content)
        .sort();
      expect(allContents).toEqual(['a', 'b', 'c']);
    });
  });
});
