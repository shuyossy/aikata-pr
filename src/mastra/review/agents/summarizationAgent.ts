import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { SummarizationAgentRequestContext } from '../requestContext.js';
import { createModelFromContext } from '../../shared/requestContext.js';

/**
 * RequestContextから要約エージェントのsystemプロンプト（instructions）を組み立てる
 *
 * 以下の要素を含む:
 * - 要約に特化した役割提示
 * - 作業背景（チェック項目一覧、MR情報、レビュー済み結果）
 * - 要約結果に含めるべき情報の指示（レビュー継続に必要な文脈情報）
 */
export function buildSummarizationInstructions(
  requestContext: RequestContext<SummarizationAgentRequestContext>,
): string {
  const ctx = requestContext.all;

  const checkItemsText = ctx.checkItems
    .map((item) => `[ID: ${item.id}]\n${item.content}`)
    .join('\n\n');

  return `You are a conversation summarization specialist for an MR code review process.

A review agent was evaluating merge request changes against a set of check items, but was interrupted due to a context length limitation. Your task is to produce a concise summary of the agent's work so that the review can be resumed effectively.

## Work Background

The review agent was reviewing the following check items:
${checkItemsText}

Note: Check items may use a structured format with headers and values delimited by \`---\`, or may appear as plain text. The [ID: N] prefix identifies each item.

The review was being performed against a merge request:
- MR Title: ${ctx.mrTitle}
- Source Branch: ${ctx.mrSourceBranch} → Target Branch: ${ctx.mrTargetBranch}

Items that already have stored results (no need to re-summarize their final ratings):
${ctx.alreadyStoredSummary}

## Summary Purpose

The summary will be used by a follow-up agent session to CONTINUE the review of remaining items. Focus on information that helps the next session work efficiently — not on archiving what was already completed.

## Summary Requirements

1. **Codebase understanding**: Summarize any understanding of the codebase, architecture, or patterns that the agent discovered during investigation. This context is valuable for reviewing remaining items.

2. **In-progress items**: For check items where review was underway but not yet stored:
   - What investigation had been started
   - What findings were made so far
   - What additional information or investigation was still needed

3. **Cross-cutting observations**: Any broader patterns, concerns, or discoveries that may be relevant to the remaining items.

${
  ctx.hasImages
    ? `4. **Image references**: The conversation contained image file reads. Image placeholders in the serialized text (e.g., [Image: path/to/file.png]) correspond to actual image data provided as separate image content parts. Use these images to understand what the review agent was analyzing and include relevant visual observations in your summary.

`
    : ''
}## Format Guidelines
- Be concise — the summary must not be so large that it causes another context length error.
- Do NOT include raw code diffs or full tool output — summarize conclusions only.
- Do NOT re-state the final ratings of already-stored items.
- Organize by topic or check item for easy reference.`;
}

/**
 * 要約エージェントのuserプロンプトを組み立てる
 *
 * 以下の構成:
 * 1. シリアライズ形式の説明
 * 2. 圧縮情報（中間カット時のみ）
 * 3. シリアライズされた会話履歴
 */
export function buildSummarizationUserPrompt(
  serializedMessages: string,
  wasTrimmed: boolean,
): string {
  const parts: string[] = [];

  parts.push(`## Conversation History format

The following conversation history is a serialized transcript of the review agent's work. Each message is prefixed with its role in brackets (e.g., [user], [assistant], [tool-result]). Tool call arguments and results are included as nested text blocks.`);

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
 * 要約エージェント（シングルトン）
 *
 * コンテキスト長エラー発生時にレビューエージェントの作業履歴を要約するエージェント。
 * メモリなし、ツールなし、ワークスペースなし。
 * モデルはRequestContextから動的に生成される。
 */
export const summarizationAgent = new Agent<
  'summarization-agent',
  Record<string, never>,
  undefined,
  SummarizationAgentRequestContext
>({
  id: 'summarization-agent',
  name: 'Summarization Agent',
  model: ({ requestContext }) => {
    const ctx = requestContext.all as SummarizationAgentRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: ({ requestContext }) => {
    return buildSummarizationInstructions(requestContext);
  },
});
