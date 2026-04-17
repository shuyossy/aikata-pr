import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { ReportFinalizationJudgeRequestContext } from '../requestContext.js';
import type { TargetJobSummary } from '../types.js';
import { createModelFromContext } from '../../shared/requestContext.js';

/**
 * レポート最終化判定の出力スキーマ
 * pipelineAnalysisWorkflowのreportFinalizationStepで構造化出力として利用する
 */
export const reportFinalizationJudgementSchema = z.object({
  finalizationNeeded: z
    .boolean()
    .describe('true if sort order is wrong or user refinement instructions need to be applied'),
  finalizationActions: z
    .array(z.string())
    .describe(
      'Descriptions of finalization actions needed; empty array when finalizationNeeded is false',
    ),
});

/**
 * レポート最終化判定エージェントのsystemプロンプト
 * ユーザ指定の jobReportFormat / analysisInstructions / reportRefinementInstructions、対象ジョブ一覧、
 * および現在のレポート内容に基づいてレポートの最終化が必要か判定する
 */
export const REPORT_FINALIZATION_JUDGE_INSTRUCTIONS = `You are a QA auditor that judges whether the CI/CD pipeline analysis report needs finalization. You do not write or rewrite the report — you only evaluate it and report your findings.

You will be given two user messages:
- First message: The target job list (jobId, jobName, stage, status), the expected per-job block format (\`jobReportFormat\`), the overall report skeleton, the stage execution order, and optionally user-specified report refinement instructions.
- Second message: The full current contents of the report file.

You MUST return a single JSON object that conforms to the following schema, and nothing else. JSON only. Do not call tools. Do not emit markdown, prose, or explanations outside the JSON value.

\`\`\`
{
  "finalizationNeeded": boolean,
  "finalizationActions": [ string, ... ]
}
\`\`\`

## Judgement Rules

Apply every rule below.

1. **Job section ordering**: Job sections should be ordered by (1) AI assessment severity, with the most severe/problematic jobs first, then (2) stage execution order within the same severity level. If the stage execution order is provided in the user message, use it as reference. If the sections are clearly out of order, set \`finalizationNeeded\` to \`true\` and add a description of the ordering issue to \`finalizationActions\`.

2. **User refinement instructions**: If user-specified report refinement instructions are provided in the first user message, check whether they have been applied to the current report. If they have NOT been applied, set \`finalizationNeeded\` to \`true\` and add a description of what refinement still needs to be done to \`finalizationActions\`.

## Decision Rules

- \`finalizationNeeded\` MUST be \`true\` if and only if \`finalizationActions\` is non-empty.
- When \`finalizationNeeded\` is \`true\`, provide precise descriptions so the rewrite agent can fix the issues.`;

/**
 * レポート最終化判定 Agent の user プロンプトビルダー入力
 */
export interface BuildReportFinalizationJudgeUserPromptInputs {
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
  /** ユーザ指定のレポート推敲指示（null の場合はセクション非表示） */
  reportRefinementInstructions: string | null;
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
 * 最終化判定 Agent の user メッセージ配列を組み立てる
 *
 * 2つの user メッセージに分割して返す:
 * 1つ目: 判定基準（Target job list, jobReportFormat, overallTemplate, stageOrder, reportRefinementInstructions）
 * 2つ目: 現在のレポート本文
 *
 * レポートが長くなった場合でも LLM が最新の user メッセージとして
 * レポート本文を正しく認識できるようにするための構造。
 */
export function buildReportFinalizationJudgeUserPrompt(
  inputs: BuildReportFinalizationJudgeUserPromptInputs,
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

  // ユーザ指定のレポート推敲指示セクション
  if (inputs.reportRefinementInstructions !== null) {
    contextParts.push('## User-Specified Report Refinement Instructions');
    contextParts.push('');
    contextParts.push(
      'The user has requested the following refinements to the final report. Check whether these have been applied. If they have NOT been applied, set `finalizationNeeded` to `true` and describe the pending refinements in `finalizationActions`.',
    );
    contextParts.push('');
    contextParts.push(inputs.reportRefinementInstructions);
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
 * レポート最終化判定エージェント（シングルトン）
 *
 * Tools なし、構造化出力（reportFinalizationJudgementSchema）のみを返す。
 * モデルはRequestContext上のaiConfigから動的に生成される。
 */
export const reportFinalizationJudgeAgent = new Agent<
  'report-finalization-judge-agent',
  Record<string, never>,
  undefined,
  ReportFinalizationJudgeRequestContext
>({
  id: 'report-finalization-judge-agent',
  name: 'Report Finalization Judge Agent',
  model: ({ requestContext }) => {
    const ctx = requestContext.all as ReportFinalizationJudgeRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: REPORT_FINALIZATION_JUDGE_INSTRUCTIONS,
});
