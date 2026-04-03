import { describe, it, expect } from 'vitest';
import { QualityGate } from '../QualityGate.js';
import { ReviewResult } from '../../reviewResult/index.js';
import { CheckItem } from '../../checkItem/index.js';
import { Rating } from '../../rating/index.js';

/** テスト用のレビュー結果を生成する */
function createSuccessResult(ratingLabel: string): ReviewResult {
  return ReviewResult.success(
    new CheckItem(`チェック項目_${ratingLabel}`),
    new Rating(ratingLabel, `${ratingLabel}の定義`),
    'コメント',
  );
}

/** テスト用のエラーレビュー結果を生成する */
function createErrorResult(): ReviewResult {
  return ReviewResult.error(new CheckItem('エラー項目'), 'エラーメッセージ');
}

describe('QualityGate', () => {
  describe('構築', () => {
    it('有効な基準で構築できる', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 1 }]);
      expect(gate.failureCriteria).toEqual([{ ratingLabel: 'C', threshold: 1 }]);
    });

    it('複数の基準で構築できる', () => {
      const criteria = [
        { ratingLabel: 'C', threshold: 1 },
        { ratingLabel: 'B', threshold: 3 },
      ];
      const gate = new QualityGate(criteria);
      expect(gate.failureCriteria).toHaveLength(2);
    });

    it('none()で基準なしの品質ゲートを生成できる', () => {
      const gate = QualityGate.none();
      expect(gate.failureCriteria).toEqual([]);
    });

    it('thresholdが0以下の場合はエラーになる', () => {
      expect(() => new QualityGate([{ ratingLabel: 'C', threshold: 0 }])).toThrow();
      expect(() => new QualityGate([{ ratingLabel: 'C', threshold: -1 }])).toThrow();
    });

    it('ratingLabelが空文字の場合はエラーになる', () => {
      expect(() => new QualityGate([{ ratingLabel: '', threshold: 1 }])).toThrow();
    });
  });

  describe('evaluate', () => {
    it('基準なし（none）の場合は常にpassする', () => {
      const gate = QualityGate.none();
      const results = [createSuccessResult('C'), createSuccessResult('C')];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('基準に抵触する場合はfailする', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 2 }]);
      const results = [createSuccessResult('C'), createSuccessResult('C')];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(false);
      expect(result.violations).toEqual([{ ratingLabel: 'C', threshold: 2, actualCount: 2 }]);
    });

    it('基準に抵触しない場合はpassする', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 2 }]);
      const results = [createSuccessResult('C')];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('countがthresholdを超える場合もfailする', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 1 }]);
      const results = [
        createSuccessResult('C'),
        createSuccessResult('C'),
        createSuccessResult('C'),
      ];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(false);
      expect(result.violations[0].actualCount).toBe(3);
    });

    it('OR条件: 複数基準のうち1つでも抵触すればfailする', () => {
      const gate = new QualityGate([
        { ratingLabel: 'C', threshold: 2 },
        { ratingLabel: 'B', threshold: 3 },
      ]);
      // Cが2件 → 基準1に抵触、Bは1件 → 基準2は未抵触
      const results = [
        createSuccessResult('C'),
        createSuccessResult('C'),
        createSuccessResult('B'),
      ];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].ratingLabel).toBe('C');
    });

    it('複数の基準が同時に抵触する場合は全てのviolationを返す', () => {
      const gate = new QualityGate([
        { ratingLabel: 'C', threshold: 1 },
        { ratingLabel: 'B', threshold: 1 },
      ]);
      const results = [createSuccessResult('C'), createSuccessResult('B')];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(2);
    });

    it('エラー結果は評価から除外される', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 1 }]);
      // エラー結果のみ → Cカウントは0
      const results = [createErrorResult(), createErrorResult()];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(true);
    });

    it('空の結果配列の場合はpassする', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 1 }]);
      const result = gate.evaluate([]);
      expect(result.passed).toBe(true);
    });

    it('actualCountが正確に報告される', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 1 }]);
      const results = [
        createSuccessResult('A'),
        createSuccessResult('C'),
        createSuccessResult('C'),
        createSuccessResult('C'),
        createSuccessResult('B'),
      ];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(false);
      expect(result.violations[0].actualCount).toBe(3);
    });

    it('基準にないラベルの結果は無視される', () => {
      const gate = new QualityGate([{ ratingLabel: 'C', threshold: 1 }]);
      const results = [createSuccessResult('A'), createSuccessResult('B')];
      const result = gate.evaluate(results);
      expect(result.passed).toBe(true);
    });
  });
});
