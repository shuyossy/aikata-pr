import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type {
  PipelineReportSummarizationRequestContext,
  WorkflowAiConfig,
} from '../requestContext.js';
import type { TargetJobSummary } from '../types.js';

/**
 * pipeline-reportのaiConfigからAIモデルを動的に作成するヘルパー
 * review側のcreateModelFromContext相当だが、aiConfigがネストしているため
 * pipeline-report専用のファクトリとして定義している
 */
export function createModelFromAiConfig(config: WorkflowAiConfig) {
  return createOpenAICompatible({
    name: 'openai',
    apiKey: config.apiKey,
    baseURL: config.endpointUrl,
  }).chatModel(config.modelName);
}

/**
 * 対象ジョブ一覧をMarkdownの箇条書きとしてレンダリングする
 */
function renderTargetJobsList(jobs: TargetJobSummary[]): string {
  if (jobs.length === 0) {
    return '- (no target jobs)';
  }
  return jobs
    .map((job) => `- #${job.id} \`${job.name}\` (stage: ${job.stage}, status: ${job.status})`)
    .join('\n');
}

/**
 * RequestContextからpipeline-report用要約エージェントのsystemプロンプト（instructions）を組み立てる
 *
 * 以下の要素を含む:
 * - 要約に特化した役割提示
 * - 作業背景（対象ジョブ一覧）
 * - 要約結果に含めるべき情報の指示（分析継続に必要な文脈情報）
 */
export function buildPipelineReportSummarizationInstructions(
  requestContext: RequestContext<PipelineReportSummarizationRequestContext>,
): string {
  const ctx = requestContext.all;
  const jobsList = renderTargetJobsList(ctx.targetJobs);

  return `You are a specialist for summarizing a CI pipeline analysis conversation.

A pipeline analysis agent was analyzing every job in a GitLab CI pipeline against a report template, but its work was interrupted due to a context length limitation. Your job is to produce a concise summary of the agent's progress so that the analysis can be resumed effectively.

## Work Background

The analysis agent was asked to produce a per-job analysis for the following target jobs:

${jobsList}

Some of these jobs may have already been analyzed and written into the report file, while others may still be in progress or not started yet.

## Summary Purpose

The summary will be consumed by a follow-up agent session that CONTINUES the pipeline analysis of the remaining jobs. Focus on information that lets the next session resume efficiently — not on archiving what was already finalized.

## Summary Requirements

1. **Per-job progress**: For each target job, note whether it has already been analyzed and written into the report, is partially investigated, or has not been touched yet.
2. **Observations from tool calls**: Summarize what was learned through tool calls (getArtifactContent, getJobLogDetail, workspace file reads, etc.) — such as suspicious log lines, failing tests, error messages, artifact contents. Record the conclusions, not the raw tool output.
3. **Cross-cutting patterns**: Pipeline-wide issues that may affect multiple jobs (shared dependency failures, infra problems, flaky tests) — these save time for the continuation session.
4. **Open questions and next steps**: Jobs that still need investigation, the specific questions that remain, and any partial evidence already gathered for them.

## Format Guidelines

- Be concise — the summary must not be so large that it re-triggers another context length error.
- Do NOT include raw tool output, raw job logs, or raw artifact content. Summarize conclusions only.
- Do NOT re-state the full text of report blocks that are already written; just note that the block exists and is finalized.
- Organize by job id for easy reference, followed by a short "cross-cutting" section.`;
}

/**
 * pipeline-report用要約エージェントのuserプロンプトを組み立てる
 *
 * 以下の構成:
 * 1. シリアライズ形式の説明
 * 2. 圧縮情報（中間カット時のみ）
 * 3. シリアライズされた会話履歴
 */
export function buildPipelineReportSummarizationUserPrompt(
  serializedMessages: string,
  wasTrimmed: boolean,
): string {
  const parts: string[] = [];

  parts.push(`## Conversation History Format

The following conversation history is a serialized transcript of the pipeline analysis agent's work. Each message is prefixed with its role in brackets (e.g., [user], [assistant], [tool-result]). Tool call arguments and results are included as nested text blocks.`);

  if (wasTrimmed) {
    parts.push(`
## Compression Notice

The conversation history below has been trimmed due to length constraints. The oldest 10% and newest 50% of messages are preserved; messages from the middle of the conversation were omitted. Be aware that some investigation context from the middle portion may be missing.`);
  }

  parts.push(`
## Conversation History

${serializedMessages}`);

  return parts.join('\n');
}

/**
 * pipeline-report用要約エージェント（シングルトン）
 *
 * コンテキスト長エラー発生時にpipelineAnalysisAgentの作業履歴を要約するエージェント。
 * メモリなし、ツールなし、ワークスペースなし。
 * モデルはRequestContext上のaiConfigから動的に生成される。
 */
export const pipelineReportSummarizationAgent = new Agent<
  'pipeline-report-summarization-agent',
  Record<string, never>,
  undefined,
  PipelineReportSummarizationRequestContext
>({
  id: 'pipeline-report-summarization-agent',
  name: 'Pipeline Report Summarization Agent',
  model: ({ requestContext }) => {
    const ctx = requestContext.all as PipelineReportSummarizationRequestContext;
    return createModelFromAiConfig(ctx.aiConfig);
  },
  instructions: ({ requestContext }) => {
    return buildPipelineReportSummarizationInstructions(requestContext);
  },
});
