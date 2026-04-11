import { ReviewResult } from '../reviewResult/index.js';

/** 品質ゲートの失敗基準（評定ラベルと閾値のペア） */
export interface FailureCriterion {
  readonly ratingLabel: string;
  readonly threshold: number;
}

/** 品質ゲート違反の詳細 */
export interface QualityGateViolation {
  readonly ratingLabel: string;
  readonly threshold: number;
  readonly actualCount: number;
}

/** 品質ゲートの評価結果 */
export interface QualityGateResult {
  readonly passed: boolean;
  readonly violations: readonly QualityGateViolation[];
}

/**
 * 品質ゲートの値オブジェクト
 * レビュー結果に基づいてパイプラインの成否を判定する失敗基準を保持する
 */
export class QualityGate {
  readonly failureCriteria: readonly FailureCriterion[];

  constructor(failureCriteria: FailureCriterion[]) {
    for (const criterion of failureCriteria) {
      if (!criterion.ratingLabel) {
        throw new Error('FailureCriterion ratingLabel must not be empty');
      }
      if (criterion.threshold < 1) {
        throw new Error('FailureCriterion threshold must be at least 1');
      }
    }
    this.failureCriteria = Object.freeze([...failureCriteria]);
  }

  /** 基準なしの品質ゲートを生成する */
  static none(): QualityGate {
    return new QualityGate([]);
  }

  /**
   * レビュー結果を品質ゲートで評価する
   * エラー結果は評価から除外し、非エラー結果の評定ラベル別カウントと基準を比較する
   * いずれかの基準に抵触した場合はfailed（OR条件）
   */
  evaluate(results: ReviewResult[]): QualityGateResult {
    if (this.failureCriteria.length === 0) {
      return { passed: true, violations: [] };
    }

    // 非エラー結果の評定ラベル別カウントを集計
    const counts = new Map<string, number>();
    for (const r of results) {
      if (!r.isError) {
        const label = r.rating.label;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }

    // 各基準を評価（OR条件）
    const violations: QualityGateViolation[] = [];
    for (const criterion of this.failureCriteria) {
      const actualCount = counts.get(criterion.ratingLabel) ?? 0;
      if (actualCount >= criterion.threshold) {
        violations.push({
          ratingLabel: criterion.ratingLabel,
          threshold: criterion.threshold,
          actualCount,
        });
      }
    }

    return {
      passed: violations.length === 0,
      violations: Object.freeze(violations),
    };
  }
}
