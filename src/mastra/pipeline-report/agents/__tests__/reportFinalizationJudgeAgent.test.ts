import { describe, it, expect } from 'vitest';
import {
  reportFinalizationJudgeAgent,
  reportFinalizationJudgementSchema,
  REPORT_FINALIZATION_JUDGE_INSTRUCTIONS,
  buildReportFinalizationJudgeUserPrompt,
} from '../reportFinalizationJudgeAgent.js';
import type { TargetJobSummary } from '../../types.js';

describe('REPORT_FINALIZATION_JUDGE_INSTRUCTIONS', () => {
  it('QA監査役の役割が明示される', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toContain('QA auditor');
  });

  it('JSONのみ返す指示が含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/JSON only/i);
  });

  it('hasMissingJobs の出力フィールド説明が含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toContain('hasMissingJobs');
  });

  it('finalizationNeeded の出力フィールド説明が含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toContain('finalizationNeeded');
  });

  it('finalizationActions の出力フィールド説明が含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toContain('finalizationActions');
  });

  it('missingJobReasons の出力フィールド説明が含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toContain('missingJobReasons');
  });

  it('2つのuserメッセージで入力を受け取ることが明示される', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/two user messages/i);
  });

  it('対象ジョブ網羅の判定ルールが含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/target job/i);
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/missing/i);
  });

  it('ジョブセクション順序に関する判定ルールが含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/order/i);
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/stage/i);
  });

  it('ユーザ推敲指示に関する判定ルールが含まれる', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/refinement instructions/i);
  });

  it('ツールを使用しない（JSONのみ）ことが明示される', () => {
    expect(REPORT_FINALIZATION_JUDGE_INSTRUCTIONS).toMatch(/do not call tools|no tools/i);
  });
});

describe('reportFinalizationJudgementSchema', () => {
  it('hasMissingJobs=false, finalizationNeeded=false かつ配列が空の入力をパースできる', () => {
    const parsed = reportFinalizationJudgementSchema.parse({
      hasMissingJobs: false,
      missingJobReasons: [],
      finalizationNeeded: false,
      finalizationActions: [],
    });
    expect(parsed.hasMissingJobs).toBe(false);
    expect(parsed.missingJobReasons).toEqual([]);
    expect(parsed.finalizationNeeded).toBe(false);
    expect(parsed.finalizationActions).toEqual([]);
  });

  it('hasMissingJobs=true かつ missingJobReasons に理由が含まれる入力をパースできる', () => {
    const parsed = reportFinalizationJudgementSchema.parse({
      hasMissingJobs: true,
      missingJobReasons: [
        "Job #101 'build' has no block in the report",
        "Job #102 'deploy' is missing from the report",
      ],
      finalizationNeeded: false,
      finalizationActions: [],
    });
    expect(parsed.hasMissingJobs).toBe(true);
    expect(parsed.missingJobReasons).toHaveLength(2);
    expect(parsed.missingJobReasons[0]).toContain('build');
  });

  it('finalizationNeeded=true かつ finalizationActions に理由が含まれる入力をパースできる', () => {
    const parsed = reportFinalizationJudgementSchema.parse({
      hasMissingJobs: false,
      missingJobReasons: [],
      finalizationNeeded: true,
      finalizationActions: [
        'Job sections are not ordered by assessment severity',
        'User refinement instructions have not been applied: hide successful jobs',
      ],
    });
    expect(parsed.finalizationNeeded).toBe(true);
    expect(parsed.finalizationActions).toHaveLength(2);
  });

  it('missingJobReasons が欠けている入力はパースに失敗する', () => {
    const result = reportFinalizationJudgementSchema.safeParse({
      hasMissingJobs: false,
      finalizationNeeded: false,
      finalizationActions: [],
    });
    expect(result.success).toBe(false);
  });

  it('finalizationActions が欠けている入力はパースに失敗する', () => {
    const result = reportFinalizationJudgementSchema.safeParse({
      hasMissingJobs: false,
      missingJobReasons: [],
      finalizationNeeded: false,
    });
    expect(result.success).toBe(false);
  });

  it('各フィールドにdescribeが設定されている', () => {
    const shape = reportFinalizationJudgementSchema.shape;
    expect(shape.hasMissingJobs.description).toBeDefined();
    expect(shape.missingJobReasons.description).toBeDefined();
    expect(shape.finalizationNeeded.description).toBeDefined();
    expect(shape.finalizationActions.description).toBeDefined();
  });
});

describe('reportFinalizationJudgeAgent', () => {
  it('正しいIDと名前が設定されている', () => {
    expect(reportFinalizationJudgeAgent.id).toBe('report-finalization-judge-agent');
    expect(reportFinalizationJudgeAgent.name).toBe('Report Finalization Judge Agent');
  });
});

describe('buildReportFinalizationJudgeUserPrompt', () => {
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
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: null,
    });

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('user');
  });

  it('1つ目のメッセージにTarget Jobs・jobReportFormat・overallTemplateが含まれる', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: null,
    });

    expect(result[0].content).toContain('Target Jobs');
    expect(result[0].content).toContain('jobReportFormat');
    expect(result[0].content).toContain('overallTemplate');
    expect(result[0].content).toContain('### ジョブ #<jobId>');
    expect(result[0].content).toContain('# レポート');
  });

  it('1つ目のメッセージにレポート本文が含まれない', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: null,
    });

    expect(result[0].content).not.toContain('Current Report Contents');
    expect(result[0].content).not.toContain('# テストレポート');
  });

  it('2つ目のメッセージにレポート本文が含まれる', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: null,
    });

    expect(result[1].content).toContain('Current Report Contents');
    expect(result[1].content).toContain('# テストレポート');
  });

  it('2つ目のメッセージにTarget Jobsが含まれない', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: null,
    });

    expect(result[1].content).not.toContain('Target Jobs');
    expect(result[1].content).not.toContain('jobReportFormat');
  });

  it('stageOrderが指定された場合、1つ目のメッセージにStage Execution Orderセクションが含まれる', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: ['check', 'test', 'deploy'],
      reportRefinementInstructions: null,
    });

    expect(result[0].content).toContain('Stage Execution Order');
    expect(result[0].content).toContain('check');
    expect(result[0].content).toContain('test');
    expect(result[0].content).toContain('deploy');
  });

  it('stageOrderが空配列の場合、Stage Execution Orderセクションが含まれない', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: null,
    });

    expect(result[0].content).not.toContain('Stage Execution Order');
  });

  it('reportRefinementInstructionsが指定された場合、1つ目のメッセージに推敲指示セクションが含まれる', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: 'Hide jobs that passed without issues.',
    });

    expect(result[0].content).toContain('User-Specified Report Refinement Instructions');
    expect(result[0].content).toContain('Hide jobs that passed without issues.');
    expect(result[0].content).toContain('finalizationNeeded');
    expect(result[0].content).toContain('finalizationActions');
  });

  it('reportRefinementInstructionsがnullの場合、推敲指示セクションが含まれない', () => {
    const result = buildReportFinalizationJudgeUserPrompt({
      ...baseInputs,
      stageOrder: [],
      reportRefinementInstructions: null,
    });

    expect(result[0].content).not.toContain('User-Specified Report Refinement Instructions');
    expect(result[0].content).not.toContain('refinements');
  });
});
