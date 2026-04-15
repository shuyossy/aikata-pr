import { Agent } from '@mastra/core/agent';
import type { ReportRewriteAgentRequestContext } from '../requestContext.js';
import { createModelFromContext } from '../../shared/requestContext.js';

/**
 * reportRewriteAgent のユーザプロンプトビルダーの入力型
 */
export interface BuildReportRewriteUserPromptInputs {
  currentReportContent: string;
  finalizationActions: string[];
  reportRefinementInstructions: string | null;
  commentLanguage: string;
}

/**
 * reportRewriteAgent の system プロンプト
 *
 * レポートの構造的な書き換え（セクション順序変更・表示/非表示切り替え・フォーマット調整）を行う専門家として振る舞う。
 * 分析エージェントが記述した元の分析内容・文言を厳密に保持することを最重要制約とする。
 */
export const REPORT_REWRITE_AGENT_INSTRUCTIONS = `You are a report rewrite specialist for CI/CD pipeline analysis reports. Your sole responsibility is to rewrite the given report according to a set of finalization actions and optional user-specified instructions.

## CRITICAL CONSTRAINT — Preserve Original Content

You MUST preserve the original analysis content and wording exactly as written by the analysis agent.

Specifically, you MUST NOT alter, rephrase, summarize, or remove any of the following:
- Factual findings and observations
- Evidence citations (log lines, artifact excerpts, file paths)
- AI assessments and severity ratings
- Recommended actions and next steps

You are ONLY permitted to change:
- The structural order of job sections (reordering)
- Visibility of sections (showing or hiding based on finalization actions)
- Formatting adjustments as explicitly specified in the finalization actions
- Content modifications explicitly requested by user-specified report refinement instructions

When rewriting, copy the original text of each section verbatim. Do not "improve" wording, do not fix perceived grammar issues in the original content, and do not add or remove information.

**Exception — User-Specified Instructions**: If user-specified report refinement instructions are provided in the user message, they may override this constraint for the specific changes they request. For example, the user may ask to remove certain job sections, rewrite descriptions, or restructure content. Apply those changes as instructed. However, for all content NOT affected by user instructions, this constraint remains in full effect — preserve the original text verbatim.

## Input Format

You will receive a single user message containing:
1. A list of finalization actions to apply to the report
2. (Optional) User-specified report refinement instructions for additional customization
3. The current full report content in Markdown

## Output Format

Output ONLY the complete rewritten report in Markdown format. Do not include any explanations, preamble, or commentary before or after the report. Do not wrap the report in a code block. The output must be the final report ready for delivery.`;

/**
 * reportRewriteAgent の user プロンプトを組み立てる
 *
 * finalizationActions（ソート修正・表示制御等）および任意のユーザ推敲指示と
 * 現在のレポート本文を1つの user メッセージとして構成する。
 */
export function buildReportRewriteUserPrompt(inputs: BuildReportRewriteUserPromptInputs): string {
  const parts: string[] = [];

  // ファイナライゼーションアクション
  parts.push('## Finalization Actions');
  parts.push('');
  parts.push('Apply the following changes to the report:');
  parts.push('');
  for (const action of inputs.finalizationActions) {
    parts.push(`- ${action}`);
  }
  parts.push('');

  // ユーザ指定のレポート推敲指示（存在する場合のみ）
  if (inputs.reportRefinementInstructions !== null) {
    parts.push('## User-Specified Report Refinement Instructions');
    parts.push('');
    parts.push(inputs.reportRefinementInstructions);
    parts.push('');
  }

  // 言語指定
  parts.push('## Language');
  parts.push('');
  parts.push(`Write the report content in ${inputs.commentLanguage}.`);
  parts.push('');

  // 現在のレポート本文
  parts.push('## Current Report');
  parts.push('');
  parts.push('```markdown');
  parts.push(inputs.currentReportContent);
  parts.push('```');

  return parts.join('\n');
}

/**
 * reportRewriteAgent（シングルトン）
 *
 * 完成判定ステップで検出されたファイナライゼーションアクション（ソート順修正・ユーザ推敲指示の適用等）を
 * 受けてレポートを書き換える専門エージェント。
 * ツールなし、メモリなし。モデルは RequestContext から動的に生成される。
 */
export const reportRewriteAgent = new Agent<
  'report-rewrite-agent',
  Record<string, never>,
  undefined,
  ReportRewriteAgentRequestContext
>({
  id: 'report-rewrite-agent',
  name: 'Report Rewrite Agent',
  model: ({ requestContext }) => {
    const ctx = requestContext.all as ReportRewriteAgentRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: REPORT_REWRITE_AGENT_INSTRUCTIONS,
});
