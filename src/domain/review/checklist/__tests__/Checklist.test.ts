import { describe, it, expect } from 'vitest';
import { Checklist } from '../Checklist.js';
import { CheckItem } from '../../checkItem/index.js';

describe('Checklist', () => {
  const items = [
    new CheckItem('item1'),
    new CheckItem('item2'),
    new CheckItem('item3'),
    new CheckItem('item4'),
    new CheckItem('item5'),
  ];

  it('チェック項目一覧を保持する', () => {
    const checklist = new Checklist(items);
    expect(checklist.items).toEqual(items);
    expect(checklist.size).toBe(5);
  });

  it('空のチェック項目一覧ではエラーになる', () => {
    expect(() => new Checklist([])).toThrow();
  });

  describe('splitByCount', () => {
    it('指定数ごとに均等に分割できる（割り切れる場合）', () => {
      const checklist = new Checklist([
        new CheckItem('a'),
        new CheckItem('b'),
        new CheckItem('c'),
        new CheckItem('d'),
      ]);
      const groups = checklist.splitByCount(2);
      expect(groups.length).toBe(2);
      expect(groups[0].length).toBe(2);
      expect(groups[1].length).toBe(2);
    });

    it('指定数ごとに分割できる（端数あり）', () => {
      const checklist = new Checklist(items); // 5 items
      const groups = checklist.splitByCount(3);
      expect(groups.length).toBe(2);
      expect(groups[0].length).toBe(3);
      expect(groups[1].length).toBe(2);
    });

    it('全項目が過不足なく含まれる', () => {
      const checklist = new Checklist(items);
      const groups = checklist.splitByCount(2);
      const flattened = groups.flat();
      expect(flattened.length).toBe(items.length);
      for (const item of items) {
        expect(flattened.some((f) => f.equals(item))).toBe(true);
      }
    });

    it('countが総項目数以上の場合は1グループになる', () => {
      const checklist = new Checklist(items);
      const groups = checklist.splitByCount(10);
      expect(groups.length).toBe(1);
      expect(groups[0].length).toBe(5);
    });

    it('countが1の場合は各項目が個別グループになる', () => {
      const checklist = new Checklist(items);
      const groups = checklist.splitByCount(1);
      expect(groups.length).toBe(5);
      groups.forEach((g) => expect(g.length).toBe(1));
    });
  });
});
