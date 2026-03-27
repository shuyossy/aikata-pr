import { CheckItem } from '../checkItem/index.js';

/**
 * チェックリストエンティティ
 * 複数のチェック項目で構成される
 */
export class Checklist {
  readonly items: CheckItem[];

  constructor(items: CheckItem[]) {
    if (items.length === 0) {
      throw new Error('Checklist must contain at least one item');
    }
    this.items = [...items];
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * 指定された数ごとにチェック項目を機械的に分割する
   */
  splitByCount(count: number): CheckItem[][] {
    if (count >= this.items.length) {
      return [[...this.items]];
    }
    const groups: CheckItem[][] = [];
    for (let i = 0; i < this.items.length; i += count) {
      groups.push(this.items.slice(i, i + count));
    }
    return groups;
  }
}
