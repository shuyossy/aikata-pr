import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import type { PipelineReportSummarizationRequestContext } from '../../requestContext.js';
import type { TargetJobSummary } from '../../types.js';
import {
  buildPipelineReportSummarizationInstructions,
  buildPipelineReportSummarizationUserPrompt,
  pipelineReportSummarizationAgent,
} from '../pipelineReportSummarizationAgent.js';

/**
 * テスト用のPipelineReportSummarizationRequestContextを生成するヘルパー
 */
function createTestContext(
  overrides: Partial<PipelineReportSummarizationRequestContext> = {},
): RequestContext<PipelineReportSummarizationRequestContext> {
  const targetJobs: TargetJobSummary[] = overrides.targetJobs ?? [
    { id: 101, name: 'build', stage: 'build', status: 'success', duration: 42 },
    { id: 102, name: 'test', stage: 'test', status: 'failed', duration: 120 },
  ];

  return new RequestContext<PipelineReportSummarizationRequestContext>([
    ['userId', overrides.userId ?? 'test-user'],
    ['projectId', overrides.projectId ?? 'test-project'],
    ['aiApiKey', overrides.aiApiKey ?? 'test-key'],
    ['aiApiEndpointUrl', overrides.aiApiEndpointUrl ?? 'http://localhost'],
    ['aiModelName', overrides.aiModelName ?? 'test-model'],
    ['projectDir', overrides.projectDir ?? '/test'],
    ['openaiReasoningEffort', overrides.openaiReasoningEffort ?? undefined],
    ['targetJobs', targetJobs],
  ]);
}

describe('buildPipelineReportSummarizationInstructions', () => {
  it('CI pipeline analysis conversation を要約する役割が明示される', () => {
    const ctx = createTestContext();

    const instructions = buildPipelineReportSummarizationInstructions(ctx);

    expect(instructions).toContain('summarizing');
    expect(instructions).toContain('CI pipeline analysis');
  });

  it('対象ジョブ一覧が含まれる', () => {
    const ctx = createTestContext({
      targetJobs: [
        { id: 10, name: 'lint', stage: 'check', status: 'success', duration: 12 },
        { id: 20, name: 'e2e', stage: 'test', status: 'failed', duration: 200 },
      ],
    });

    const instructions = buildPipelineReportSummarizationInstructions(ctx);

    expect(instructions).toContain('lint');
    expect(instructions).toContain('e2e');
    expect(instructions).toContain('#10');
    expect(instructions).toContain('#20');
  });

  it('既に分析済みジョブ状況の引き継ぎ指示（already been analyzed）が含まれる', () => {
    const ctx = createTestContext();

    const instructions = buildPipelineReportSummarizationInstructions(ctx);

    expect(instructions).toContain('already been analyzed');
  });

  it('ツール呼び出し（tool calls）の成果を保持する指示が含まれる', () => {
    const ctx = createTestContext();

    const instructions = buildPipelineReportSummarizationInstructions(ctx);

    expect(instructions).toContain('tool calls');
  });

  it('コンテキスト長エラー発生を背景として説明する', () => {
    const ctx = createTestContext();

    const instructions = buildPipelineReportSummarizationInstructions(ctx);

    expect(instructions).toContain('context length');
  });

  it('要約フォーマットの制約（簡潔さ・生ツール出力を含めない）が含まれる', () => {
    const ctx = createTestContext();

    const instructions = buildPipelineReportSummarizationInstructions(ctx);

    expect(instructions).toMatch(/concise/i);
    // 生のツール出力はそのまま貼らず、結論のみ要約する指示
    expect(instructions).toMatch(/raw tool output|raw job log|do not include raw/i);
  });
});

describe('buildPipelineReportSummarizationUserPrompt', () => {
  it('シリアライズされた会話履歴が含まれる', () => {
    const serialized = '[user] Analyze the pipeline\n[assistant] I will analyze each job';

    const prompt = buildPipelineReportSummarizationUserPrompt(serialized, false);

    expect(prompt).toContain('[user] Analyze the pipeline');
    expect(prompt).toContain('[assistant] I will analyze each job');
  });

  it('圧縮されていない場合は圧縮情報が含まれない', () => {
    const prompt = buildPipelineReportSummarizationUserPrompt('history', false);

    expect(prompt).not.toContain('omitted');
  });

  it('圧縮された場合は圧縮情報が含まれる', () => {
    const prompt = buildPipelineReportSummarizationUserPrompt('history', true);

    expect(prompt).toContain('omitted');
  });
});

describe('pipelineReportSummarizationAgent', () => {
  it('正しいIDと名前が設定されている', () => {
    expect(pipelineReportSummarizationAgent.id).toBe('pipeline-report-summarization-agent');
    expect(pipelineReportSummarizationAgent.name).toBe('Pipeline Report Summarization Agent');
  });
});
