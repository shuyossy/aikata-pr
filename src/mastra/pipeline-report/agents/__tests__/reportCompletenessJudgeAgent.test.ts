import { describe, it, expect } from 'vitest';
import {
  reportCompletenessJudgeAgent,
  reportCompletenessJudgementSchema,
  REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS,
} from '../reportCompletenessJudgeAgent.js';

describe('REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS', () => {
  it('厳格なQA監査役の役割が明示される', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('strict QA auditor');
  });

  it('JSONのみ返す指示が含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/JSON only/i);
  });

  it('missingItems / formatDeviations の出力フィールド説明が含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('missingItems');
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('formatDeviations');
  });

  it('対象ジョブ網羅の判定ルールが含まれる', () => {
    // 対象ジョブが全てレポートに存在するか
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/target job/i);
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/missing/i);
  });

  it('jobReportFormatのhint（列挙型含む）が正しく埋まっているかの判定ルールが含まれる', () => {
    // hintやプレースホルダ、列挙値についての記述
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/hint|placeholder/i);
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/enum/i);
  });

  it('additionalInstructionsを反映するルールが含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('additionalInstructions');
  });

  it('ReActフレームワークの判定シグナル（isComplete）が含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('isComplete');
  });

  it('ツールを使用しない（JSONのみ）ことが明示される', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/do not call tools|no tools/i);
  });
});

describe('reportCompletenessJudgementSchema', () => {
  it('isComplete=true かつ配列が空の入力をパースできる', () => {
    const parsed = reportCompletenessJudgementSchema.parse({
      isComplete: true,
      missingItems: [],
      formatDeviations: [],
    });
    expect(parsed.isComplete).toBe(true);
    expect(parsed.missingItems).toEqual([]);
    expect(parsed.formatDeviations).toEqual([]);
  });

  it('missingItemsの要素は jobId / jobName / reason を持つ', () => {
    const parsed = reportCompletenessJudgementSchema.parse({
      isComplete: false,
      missingItems: [
        { jobId: 101, jobName: 'build', reason: 'not present in report' },
        { jobId: 102, jobName: 'test', reason: 'evidence section is empty' },
      ],
      formatDeviations: ['job #103 block uses wrong AI rating enum value'],
    });
    expect(parsed.isComplete).toBe(false);
    expect(parsed.missingItems).toHaveLength(2);
    expect(parsed.missingItems[0]).toEqual({
      jobId: 101,
      jobName: 'build',
      reason: 'not present in report',
    });
    expect(parsed.formatDeviations).toEqual(['job #103 block uses wrong AI rating enum value']);
  });

  it('missingItemsが欠けている入力はパースに失敗する', () => {
    const result = reportCompletenessJudgementSchema.safeParse({
      isComplete: true,
      formatDeviations: [],
    });
    expect(result.success).toBe(false);
  });

  it('missingItems要素の jobId が数値でない場合はパースに失敗する', () => {
    const result = reportCompletenessJudgementSchema.safeParse({
      isComplete: false,
      missingItems: [{ jobId: 'abc', jobName: 'build', reason: 'x' }],
      formatDeviations: [],
    });
    expect(result.success).toBe(false);
  });

  it('formatDeviationsが欠けている入力はパースに失敗する', () => {
    const result = reportCompletenessJudgementSchema.safeParse({
      isComplete: true,
      missingItems: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('reportCompletenessJudgeAgent', () => {
  it('正しいIDと名前が設定されている', () => {
    expect(reportCompletenessJudgeAgent.id).toBe('report-completeness-judge-agent');
    expect(reportCompletenessJudgeAgent.name).toBe('Report Completeness Judge Agent');
  });
});
