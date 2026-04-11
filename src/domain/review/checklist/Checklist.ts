import { CheckItem } from '../checkItem/index.js';

/**
 * チェックリストエンティティ
 * 複数のチェック項目で構成される
 */
export class Checklist {
  private readonly _items: ReadonlyArray<CheckItem>;

  constructor(items: CheckItem[]) {
    if (items.length === 0) {
      throw new Error('Checklist must contain at least one item');
    }
    this._items = Object.freeze([...items]);
  }

  get items(): ReadonlyArray<CheckItem> {
    return this._items;
  }

  get size(): number {
    return this._items.length;
  }

  /**
   * 指定された数ごとにチェック項目を機械的に分割する
   */
  splitByCount(count: number): CheckItem[][] {
    if (count >= this._items.length) {
      return [[...this._items]];
    }
    const groups: CheckItem[][] = [];
    for (let i = 0; i < this._items.length; i += count) {
      groups.push(this._items.slice(i, i + count));
    }
    return groups;
  }
}
