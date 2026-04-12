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
  isComplete: z
    .boolean()
    .describe('MUST be true if and only if missingItems is empty AND formatDeviations is empty'),
  missingItems: z
    .array(
      z.object({
        jobId: z
          .number()
          .describe('ID of the job that has a missing block or unresolved placeholder'),
        jobName: z
          .string()
          .describe('Name of the job that has a missing block or unresolved placeholder'),
        reason: z
          .string()
          .describe(
            'Actionable description of why this job block is incomplete (e.g. "job block missing from the report" or "placeholder <duration> is still unresolved")',
          ),
      }),
    )
    .describe(
      'Array of jobs with missing blocks or unresolved placeholders; empty when the report is complete',
    ),
  formatDeviations: z
    .array(z.string())
    .describe(
      'Array of strings describing format violations found in the report; empty when the report is complete',
    ),
});

/**
 * レポート完全性判定エージェントのsystemプロンプト
 * ユーザ指定の jobReportFormat / additionalInstructions、対象ジョブ一覧、
 * および現在のレポート内容に基づいてレポートが完成しているか判定する
 */
export const REPORT_COMPLETENESS_JUDGE_INSTRUCTIONS = `You are a strict QA auditor for CI/CD pipeline analysis reports. Your sole responsibility is to decide whether the current report file is complete according to a strict set of rules. You do not write the report — you only judge it.

You will be given, in the user message:
1. The target job list (jobId, jobName, stage, status).
2. The expected per-job block format (\`jobReportFormat\`), with placeholder hints in angle brackets such as \`<jobId>\`, \`<duration>\`, or enum hints like \`<choose one: "A" | "B" | "C">\`.
3. Any user-supplied \`additionalInstructions\`.
4. The full current contents of the report file.

You MUST return a single JSON object that conforms to the following schema, and nothing else. JSON only. Do not call tools. Do not emit markdown, prose, or explanations outside the JSON value.

\`\`\`
{
  "isComplete": boolean,
  "missingItems": [ { "jobId": number, "jobName": string, "reason": string }, ... ],
  "formatDeviations": [ string, ... ]
}
\`\`\`

## Judgement Rules

Apply every rule below. The report is complete only when every rule passes.

1. **Target job coverage**: Every target job in the provided list MUST appear in the report with its own per-job block. If a job has no block in the report, add an entry to \`missingItems\` with \`{ jobId, jobName, reason: "job block missing from the report" }\`. Do not fabricate blocks that are not in the report.

2. **Placeholder / hint resolution**: For each per-job block, every placeholder or hint (\`<...>\`) defined in \`jobReportFormat\` MUST be replaced with a concrete value. A block where a hint still appears verbatim (for example \`<duration>\` or \`<choose one: ...>\` still written literally) is NOT complete. Record such cases in \`missingItems\` with a reason that names the unresolved placeholder.

3. **Enum hint values**: When \`jobReportFormat\` uses an enum hint such as \`<choose one: "A" | "B" | "C">\`, the written value MUST be exactly one of the listed enum values. Any value that is not in the enum is a format deviation — add a descriptive string to \`formatDeviations\` (e.g. "job #42 'test-e2e' uses unexpected AI rating value 'Maybe'").

4. **additionalInstructions compliance**: If \`additionalInstructions\` is present, verify that the report honors every concrete, testable instruction in it. Any visible violation is a format deviation — add a descriptive string to \`formatDeviations\` citing both the instruction and where it was violated.

5. **Block structure fidelity**: A per-job block that omits an entire section defined in \`jobReportFormat\` (even if the surrounding prose is plausible) is a format deviation. Record it in \`formatDeviations\`.

## Decision

- \`isComplete\` MUST be \`true\` if and only if \`missingItems\` is empty AND \`formatDeviations\` is empty.
- Otherwise \`isComplete\` MUST be \`false\`.

Be strict. Do not downgrade issues just because they look minor. When in doubt, mark the report as not complete and populate \`missingItems\` / \`formatDeviations\` with precise, actionable reasons so the analysis agent can fix them.`;

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
  /** ユーザ指定の追加指示（未指定なら null） */
  additionalInstructions: string | null;
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
 * 完全性判定 Agent の user プロンプトを組み立てる
 *
 * reportCompletenessJudgeAgent に渡すべき情報は以下の4点:
 * 1. Target job list
 * 2. Expected per-job block format (`jobReportFormat`)
 * 3. Optional `additionalInstructions`
 * 4. 現在のレポート本文
 *
 * `overallTemplate` はスケルトン理解のための補助情報として添付する。
 */
export function buildReportCompletenessJudgeUserPrompt(
  inputs: BuildReportCompletenessJudgeUserPromptInputs,
): string {
  const parts: string[] = [];

  parts.push('## Target Jobs');
  parts.push('');
  parts.push(renderTargetJobsTable(inputs.targetJobs));
  parts.push('');

  parts.push('## Expected Per-Job Block Format (`jobReportFormat`)');
  parts.push('');
  parts.push('```');
  parts.push(inputs.jobReportFormat);
  parts.push('```');
  parts.push('');

  parts.push('## Overall Report Skeleton (`overallTemplate`)');
  parts.push('');
  parts.push('```');
  parts.push(inputs.overallTemplate);
  parts.push('```');
  parts.push('');

  if (inputs.additionalInstructions && inputs.additionalInstructions.trim() !== '') {
    parts.push('## additionalInstructions');
    parts.push('');
    parts.push(inputs.additionalInstructions);
    parts.push('');
  } else {
    parts.push('## additionalInstructions');
    parts.push('');
    parts.push('_(none)_');
    parts.push('');
  }

  parts.push('## Current Report Contents');
  parts.push('');
  parts.push('```');
  parts.push(inputs.currentReportContent);
  parts.push('```');

  return parts.join('\n');
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
