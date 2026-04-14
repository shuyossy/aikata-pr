import { describe, it, expect } from 'vitest';
import {
  reportCompletenessJudgeAgent,
  reportCompletenessJudgementSchema,
  REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS,
  buildReportCompletenessJudgeUserPrompt,
} from '../reportCompletenessJudgeAgent.js';
import type { TargetJobSummary } from '../../types.js';

describe('REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS', () => {
  it('QA監査役の役割が明示される', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('QA auditor');
  });

  it('JSONのみ返す指示が含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/JSON only/i);
  });

  it('reasons の出力フィールド説明が含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('reasons');
  });

  it('2つのuserメッセージで入力を受け取ることが明示される', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/two user messages/i);
  });

  it('対象ジョブ網羅の判定ルールが含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/target job/i);
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/missing/i);
  });

  it('レポート完成度の判定ルールが含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/fully written/i);
  });

  it('isCompleteの判定シグナルが含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toContain('isComplete');
  });

  it('ツールを使用しない（JSONのみ）ことが明示される', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/do not call tools|no tools/i);
  });
});

describe('reportCompletenessJudgementSchema', () => {
  it('isComplete=true かつ reasons が空の入力をパースできる', () => {
    const parsed = reportCompletenessJudgementSchema.parse({
      isComplete: true,
      reasons: [],
    });
    expect(parsed.isComplete).toBe(true);
    expect(parsed.reasons).toEqual([]);
  });

  it('isComplete=false かつ reasons に理由が含まれる入力をパースできる', () => {
    const parsed = reportCompletenessJudgementSchema.parse({
      isComplete: false,
      reasons: [
        "Job #101 'build' has no block in the report",
        'Job sections are not ordered by assessment severity',
      ],
    });
    expect(parsed.isComplete).toBe(false);
    expect(parsed.reasons).toHaveLength(2);
    expect(parsed.reasons[0]).toContain('build');
  });

  it('reasons が欠けている入力はパースに失敗する', () => {
    const result = reportCompletenessJudgementSchema.safeParse({
      isComplete: true,
    });
    expect(result.success).toBe(false);
  });

  it('各フィールドにdescribeが設定されている', () => {
    const shape = reportCompletenessJudgementSchema.shape;
    expect(shape.isComplete.description).toBeDefined();
    expect(shape.reasons.description).toBeDefined();
  });
});

describe('reportCompletenessJudgeAgent', () => {
  it('正しいIDと名前が設定されている', () => {
    expect(reportCompletenessJudgeAgent.id).toBe('report-completeness-judge-agent');
    expect(reportCompletenessJudgeAgent.name).toBe('Report Completeness Judge Agent');
  });
});

describe('REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS - ordering rule', () => {
  it('ジョブセクション順序に関する判定ルールが含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/order/i);
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/stage/i);
  });

  it('順序違反はreasonsとして検出する指示が含まれる', () => {
    expect(REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS).toMatch(/reason/i);
  });
});

describe('buildReportCompletenessJudgeUserPrompt', () => {
  const baseInputs = {
    currentReportContent: '# テストレポート',
    targetJobs: [
      { id: 1, name: 'lint', stage: 'check', status: 'success' as const },
      { id: 2, name: 'test', stage: 'test', status: 'failed' as const },
    ] satisfies Omit<TargetJobSummary, 'duration'>[] as unknown as TargetJobSummary[],
    jobReportFormat: '### ジョブ #<jobId>',
    overallTemplate: '# レポート\n{{job-sections}}',
  };

  it('2つのuserメッセージを返す', () => {
    const result = buildReportCompletenessJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
    });

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('user');
  });

  it('1つ目のメッセージにTarget Jobs・jobReportFormat・overallTemplateが含まれる', () => {
    const result = buildReportCompletenessJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
    });

    expect(result[0].content).toContain('Target Jobs');
    expect(result[0].content).toContain('jobReportFormat');
    expect(result[0].content).toContain('overallTemplate');
    expect(result[0].content).toContain('### ジョブ #<jobId>');
    expect(result[0].content).toContain('# レポート');
  });

  it('1つ目のメッセージにレポート本文が含まれない', () => {
    const result = buildReportCompletenessJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
    });

    expect(result[0].content).not.toContain('Current Report Contents');
    expect(result[0].content).not.toContain('# テストレポート');
  });

  it('2つ目のメッセージにレポート本文が含まれる', () => {
    const result = buildReportCompletenessJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
    });

    expect(result[1].content).toContain('Current Report Contents');
    expect(result[1].content).toContain('# テストレポート');
  });

  it('2つ目のメッセージにTarget Jobsが含まれない', () => {
    const result = buildReportCompletenessJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
    });

    expect(result[1].content).not.toContain('Target Jobs');
    expect(result[1].content).not.toContain('jobReportFormat');
  });

  it('stageOrderが指定された場合、1つ目のメッセージにStage Execution Orderセクションが含まれる', () => {
    const result = buildReportCompletenessJudgeUserPrompt({
      ...baseInputs,
      stageOrder: ['check', 'test', 'deploy'],
    });

    expect(result[0].content).toContain('Stage Execution Order');
    expect(result[0].content).toContain('check');
    expect(result[0].content).toContain('test');
    expect(result[0].content).toContain('deploy');
  });

  it('stageOrderが空配列の場合、Stage Execution Orderセクションが含まれない', () => {
    const result = buildReportCompletenessJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
    });

    expect(result[0].content).not.toContain('Stage Execution Order');
  });
});
