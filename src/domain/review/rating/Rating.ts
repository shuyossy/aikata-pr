/**
 * 評定の値オブジェクト
 * ラベルとラベル定義のペアで構成される
 */
export class Rating {
  readonly label: string;
  readonly definition: string;

  constructor(label: string, definition: string) {
    if (label.trim() === '') {
      throw new Error('Rating label must not be empty');
    }
    if (definition.trim() === '') {
      throw new Error('Rating definition must not be empty');
    }
    this.label = label;
    this.definition = definition;
  }

  equals(other: Rating): boolean {
    return this.label === other.label && this.definition === other.definition;
  }
}
