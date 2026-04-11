/**
 * ワークフロー実行用のID付きチェック項目
 * ドメイン層のCheckItemに1始まり連番IDを付与したもの
 */
export interface IndexedCheckItem {
  readonly id: number;
  readonly content: string;
}

/**
 * IndexedCheckItemのコレクション
 * コンテンツ配列から1始まり連番IDを自動割り当てし、分割機能を提供する
 */
export class IndexedChecklist {
  readonly items: ReadonlyArray<IndexedCheckItem>;

  constructor(contents: string[]) {
    this.items = Object.freeze(contents.map((content, index) => ({ id: index + 1, content })));
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * 指定数ごとに分割する
   */
  splitByCount(count: number): IndexedCheckItem[][] {
    if (count <= 0) {
      throw new Error('count must be greater than 0');
    }
    const groups: IndexedCheckItem[][] = [];
    for (let i = 0; i < this.items.length; i += count) {
      groups.push(this.items.slice(i, i + count));
    }
    return groups;
  }
}
