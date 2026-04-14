import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { ReportCompletenessJudgeRequestContext } from '../requestContext.js';
import type { TargetJobSummary } from '../types.js';
import { createModelFromContext } from '../../shared/requestContext.js';

/**
 * レポート完全性判定の出力スキーマ
 * pipelineAnalysisWorkflowのverifyCompletenessStepで構造化出力として利用する
 */
export const reportCompletenessJudgementSchema = z.object({
  isComplete: z.boolean().describe('MUST be true if and only if reasons is empty'),
  reasons: z
    .array(z.string())
    .describe(
      'Array of actionable reasons why the report is not complete; empty when the report is complete',
    ),
});

/**
 * レポート完全性判定エージェントのsystemプロンプト
 * ユーザ指定の jobReportFormat / additionalInstructions、対象ジョブ一覧、
 * および現在のレポート内容に基づいてレポートが完成しているか判定する
 */
export const REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS = `You are a QA auditor for CI/CD pipeline analysis reports. Your sole responsibility is to decide whether the current report file is complete according to the rules below. You do not write the report — you only judge it.

You will be given two user messages:
- First message: The target job list (jobId, jobName, stage, status), the expected per-job block format (\`jobReportFormat\`), and the overall report skeleton.
- Second message: The full current contents of the report file.

You MUST return a single JSON object that conforms to the following schema, and nothing else. JSON only. Do not call tools. Do not emit markdown, prose, or explanations outside the JSON value.

\`\`\`
{
  "isComplete": boolean,
  "reasons": [ string, ... ]
}
\`\`\`

## Judgement Rules

Apply every rule below. The report is complete only when every rule passes.

1. **Target job coverage**: Every target job in the provided list MUST appear in the report with its own per-job block. If a job has no block, add a reason describing which job is missing.

2. **Report completeness**: The report MUST be fully written. No section in the report should be blank, contain only placeholder text, or be obviously unfinished. If any section is incomplete, add a reason describing which part is unfinished.

3. **Job section ordering**: Job sections should be ordered by (1) AI assessment severity, with the most severe/problematic jobs first, then (2) stage execution order within the same severity level. If the stage execution order is provided in the user message, use it as reference. If the sections are clearly out of order, add a reason describing the ordering issue.

## Decision

- \`isComplete\` MUST be \`true\` if and only if \`reasons\` is empty.
- Otherwise \`isComplete\` MUST be \`false\`.

When the report does not satisfy a rule above, populate \`reasons\` with precise, actionable descriptions so the analysis agent can fix the specific issues.`;

/**
 * レポート完全性判定 Agent の user プロンプトビルダー入力
 */
export interface BuildReportCompletenessJudgeUserPromptInputs {
  /** 現在のレポート本文（resultFilePath の中身） */
  currentReportContent: string;
  /** 対象ジョブ一覧 */
  targetJobs: TargetJobSummary[];
  /** ジョブ1件分のレポートブロックフォーマット */
  jobReportFormat: string;
  /** レポート全体のスケルトン */
  overallTemplate: string;
  /** ステージ実行順（ジョブセクション順序検証用） */
  stageOrder: string[];
}

/**
 * 対象ジョブ一覧を Markdown テーブルにレンダリング
 */
function renderTargetJobsTable(jobs: TargetJobSummary[]): string {
  if (jobs.length === 0) {
    return '_(no target jobs)_';
  }
  const header = '| jobId | stage | name | status |';
  const divider = '| --- | --- | --- | --- |';
  const rows = jobs.map((job) => `| ${job.id} | ${job.stage} | ${job.name} | ${job.status} |`);
  return [header, divider, ...rows].join('\n');
}

/**
 * 完全性判定 Agent の user メッセージ配列を組み立てる
 *
 * 2つの user メッセージに分割して返す:
 * 1つ目: 判定基準（Target job list, jobReportFormat, overallTemplate, stageOrder）
 * 2つ目: 現在のレポート本文
 *
 * レポートが長くなった場合でも LLM が最新の user メッセージとして
 * レポート本文を正しく認識できるようにするための構造。
 */
export function buildReportCompletenessJudgeUserPrompt(
  inputs: BuildReportCompletenessJudgeUserPromptInputs,
): Array<{ role: 'user'; content: string }> {
  // 1つ目: 判定基準コンテキスト
  const contextParts: string[] = [];

  contextParts.push('## Target Jobs');
  contextParts.push('');
  contextParts.push(renderTargetJobsTable(inputs.targetJobs));
  contextParts.push('');

  contextParts.push('## Expected Per-Job Block Format (`jobReportFormat`)');
  contextParts.push('');
  contextParts.push('```');
  contextParts.push(inputs.jobReportFormat);
  contextParts.push('```');
  contextParts.push('');

  contextParts.push('## Overall Report Skeleton (`overallTemplate`)');
  contextParts.push('');
  contextParts.push('```');
  contextParts.push(inputs.overallTemplate);
  contextParts.push('```');
  contextParts.push('');

  if (inputs.stageOrder.length > 0) {
    contextParts.push('## Stage Execution Order');
    contextParts.push('');
    contextParts.push(inputs.stageOrder.map((s) => `\`${s}\``).join(' → '));
    contextParts.push('');
  }

  // 2つ目: レポート本文
  const reportParts: string[] = [];
  reportParts.push('## Current Report Contents');
  reportParts.push('');
  reportParts.push('```');
  reportParts.push(inputs.currentReportContent);
  reportParts.push('```');

  return [
    { role: 'user' as const, content: contextParts.join('\n') },
    { role: 'user' as const, content: reportParts.join('\n') },
  ];
}

/**
 * レポート完全性判定エージェント（シングルトン）
 *
 * Tools なし、構造化出力（reportCompletenessJudgementSchema）のみを返す。
 * モデルはRequestContext上のaiConfigから動的に生成される。
 */
export const reportCompletenessJudgeAgent = new Agent<
  'report-completeness-judge-agent',
  Record<string, never>,
  undefined,
  ReportCompletenessJudgeRequestContext
>({
  id: 'report-completeness-judge-agent',
  name: 'Report Completeness Judge Agent',
  model: ({ requestContext }) => {
    const ctx = requestContext.all as ReportCompletenessJudgeRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS,
});
