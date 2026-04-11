import { describe, it, expect } from 'vitest';
import { IndexedChecklist } from '../indexedCheckItem.js';
import type { IndexedCheckItem } from '../indexedCheckItem.js';

describe('IndexedChecklist', () => {
  describe('constructor', () => {
    it('コンテンツ配列から1始まり連番IDを割り当てる', () => {
      const checklist = new IndexedChecklist(['item A', 'item B', 'item C']);

      expect(checklist.items).toEqual([
        { id: 1, content: 'item A' },
        { id: 2, content: 'item B' },
        { id: 3, content: 'item C' },
      ]);
    });

    it('空配列の場合はitemsが空になる', () => {
      const checklist = new IndexedChecklist([]);
      expect(checklist.items).toEqual([]);
    });

    it('itemsはイミュータブル', () => {
      const checklist = new IndexedChecklist(['item A']);
      expect(() => {
        (checklist.items as IndexedCheckItem[]).push({ id: 2, content: 'item B' });
      }).toThrow();
    });
  });

  describe('size', () => {
    it('アイテム数を返す', () => {
      const checklist = new IndexedChecklist(['a', 'b', 'c']);
      expect(checklist.size).toBe(3);
    });

    it('空の場合は0を返す', () => {
      const checklist = new IndexedChecklist([]);
      expect(checklist.size).toBe(0);
    });
  });

  describe('splitByCount', () => {
    it('均等に分割できる場合', () => {
      const checklist = new IndexedChecklist(['a', 'b', 'c', 'd']);
      const groups = checklist.splitByCount(2);

      expect(groups).toEqual([
        [
          { id: 1, content: 'a' },
          { id: 2, content: 'b' },
        ],
        [
          { id: 3, content: 'c' },
          { id: 4, content: 'd' },
        ],
      ]);
    });

    it('余りがある場合、最後のグループは少なくなる', () => {
      const checklist = new IndexedChecklist(['a', 'b', 'c', 'd', 'e']);
      const groups = checklist.splitByCount(3);

      expect(groups).toEqual([
        [
          { id: 1, content: 'a' },
          { id: 2, content: 'b' },
          { id: 3, content: 'c' },
        ],
        [
          { id: 4, content: 'd' },
          { id: 5, content: 'e' },
        ],
      ]);
    });

    it('countが総数以上の場合、1グループにまとまる', () => {
      const checklist = new IndexedChecklist(['a', 'b']);
      const groups = checklist.splitByCount(5);

      expect(groups).toEqual([
        [
          { id: 1, content: 'a' },
          { id: 2, content: 'b' },
        ],
      ]);
    });

    it('count=1の場合、各項目が個別グループになる', () => {
      const checklist = new IndexedChecklist(['a', 'b', 'c']);
      const groups = checklist.splitByCount(1);

      expect(groups).toEqual([
        [{ id: 1, content: 'a' }],
        [{ id: 2, content: 'b' }],
        [{ id: 3, content: 'c' }],
      ]);
    });

    it('IDが保持される', () => {
      const checklist = new IndexedChecklist(['a', 'b', 'c', 'd']);
      const groups = checklist.splitByCount(2);
      const allIds = groups.flat().map((item) => item.id);

      expect(allIds).toEqual([1, 2, 3, 4]);
    });
  });
});
