import { describe, it, expect } from 'vitest';
import { AnalysisReport } from '../AnalysisReport.js';

describe('AnalysisReport', () => {
  it('ofで渡したcontentをreadonlyで露出する', () => {
    const report = AnalysisReport.of('# Report\n- job A: ok');
    expect(report.content).toBe('# Report\n- job A: ok');
  });

  it('isEmptyは空文字の場合にtrueを返す', () => {
    expect(AnalysisReport.of('').isEmpty()).toBe(true);
  });

  it('isEmptyは空白文字のみの場合にtrueを返す', () => {
    expect(AnalysisReport.of('   \n\t  ').isEmpty()).toBe(true);
  });

  it('isEmptyは非空コンテンツの場合にfalseを返す', () => {
    expect(AnalysisReport.of('hello').isEmpty()).toBe(false);
  });
});
