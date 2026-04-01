import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import type { SummarizationAgentRequestContext } from '../../requestContext.js';
import type { IndexedCheckItem } from '../../indexedCheckItem.js';
import {
  buildSummarizationInstructions,
  buildSummarizationUserPrompt,
  summarizationAgent,
} from '../summarizationAgent.js';

/**
 * テスト用のSummarizationAgent RequestContextを生成するヘルパー
 */
function createTestContext(
  overrides: Partial<SummarizationAgentRequestContext> = {},
): RequestContext<SummarizationAgentRequestContext> {
  const checkItems: IndexedCheckItem[] = overrides.checkItems ?? [
    { id: 1, content: 'security check' },
    { id: 2, content: 'performance check' },
    { id: 3, content: 'code quality check' },
  ];

  return new RequestContext<SummarizationAgentRequestContext>([
    ['userId', overrides.userId ?? 'test-user'],
    ['aiApiKey', overrides.aiApiKey ?? 'test-key'],
    ['aiApiEndpointUrl', overrides.aiApiEndpointUrl ?? 'http://localhost'],
    ['aiModelName', overrides.aiModelName ?? 'test-model'],
    ['projectDir', overrides.projectDir ?? '/test/project'],
    ['checkItems', checkItems],
    ['mrTitle', overrides.mrTitle ?? 'Test MR Title'],
    ['mrSourceBranch', overrides.mrSourceBranch ?? 'feature/test'],
    ['mrTargetBranch', overrides.mrTargetBranch ?? 'main'],
    ['alreadyStoredSummary', overrides.alreadyStoredSummary ?? 'None yet'],
    ['openaiReasoningEffort', undefined],
    ['hasImages', overrides.hasImages ?? false],
  ]);
}

describe('buildSummarizationInstructions', () => {
  it('チェック項目リストが含まれる', () => {
    const ctx = createTestContext();

    const instructions = buildSummarizationInstructions(ctx);

    expect(instructions).toContain('[ID: 1] security check');
    expect(instructions).toContain('[ID: 2] performance check');
    expect(instructions).toContain('[ID: 3] code quality check');
  });

  it('MR情報が含まれる', () => {
    const ctx = createTestContext({
      mrTitle: 'Fix authentication bug',
      mrSourceBranch: 'fix/auth',
      mrTargetBranch: 'develop',
    });

    const instructions = buildSummarizationInstructions(ctx);

    expect(instructions).toContain('Fix authentication bug');
    expect(instructions).toContain('fix/auth');
    expect(instructions).toContain('develop');
  });

  it('レビュー済み項目の概要が含まれる', () => {
    const ctx = createTestContext({
      alreadyStoredSummary: '[ID: 1] security check - A: No issues found',
    });

    const instructions = buildSummarizationInstructions(ctx);

    expect(instructions).toContain('[ID: 1] security check - A: No issues found');
  });

  it('レビュー済み項目がない場合は "None yet" が含まれる', () => {
    const ctx = createTestContext({ alreadyStoredSummary: 'None yet' });

    const instructions = buildSummarizationInstructions(ctx);

    expect(instructions).toContain('None yet');
  });

  it('レビュー継続に必要な情報の抽出指示が含まれる', () => {
    const ctx = createTestContext();

    const instructions = buildSummarizationInstructions(ctx);

    // 要約目的: レビュー継続のための文脈情報
    expect(instructions).toContain('CONTINUE the review');
    // コードベース理解の要約指示
    expect(instructions).toContain('Codebase understanding');
    // 調査途中の項目の要約指示
    expect(instructions).toContain('In-progress items');
    // 横断的な観察事項
    expect(instructions).toContain('Cross-cutting observations');
  });

  it('要約に特化した役割提示が含まれる', () => {
    const ctx = createTestContext();

    const instructions = buildSummarizationInstructions(ctx);

    expect(instructions).toContain('summarization specialist');
    expect(instructions).toContain('context length');
  });

  it('hasImages=trueの場合、画像参照の取り扱い指示が含まれる', () => {
    const ctx = createTestContext({ hasImages: true });

    const instructions = buildSummarizationInstructions(ctx);

    expect(instructions).toContain('Image references');
    expect(instructions).toContain('[Image:');
  });

  it('hasImages=falseの場合、画像参照の取り扱い指示が含まれない', () => {
    const ctx = createTestContext({ hasImages: false });

    const instructions = buildSummarizationInstructions(ctx);

    expect(instructions).not.toContain('Image references');
  });
});

describe('buildSummarizationUserPrompt', () => {
  it('シリアライズされた会話履歴が含まれる', () => {
    const serializedMessages = '[user] Please review this code\n[assistant] I will review it';

    const prompt = buildSummarizationUserPrompt(serializedMessages, false);

    expect(prompt).toContain('[user] Please review this code');
    expect(prompt).toContain('[assistant] I will review it');
  });

  it('シリアライズ形式の説明が含まれる', () => {
    const prompt = buildSummarizationUserPrompt('some messages', false);

    // シリアライズ形式の説明があること
    expect(prompt).toContain('format');
  });

  it('圧縮されていない場合は圧縮情報が含まれない', () => {
    const prompt = buildSummarizationUserPrompt('some messages', false);

    expect(prompt).not.toContain('omitted');
  });

  it('圧縮された場合は圧縮情報が含まれる', () => {
    const prompt = buildSummarizationUserPrompt('some messages', true);

    expect(prompt).toContain('omitted');
    expect(prompt).toContain('oldest 10%');
    expect(prompt).toContain('newest 50%');
  });
});

describe('summarizationAgent', () => {
  it('正しいIDと名前が設定されている', () => {
    expect(summarizationAgent.id).toBe('summarization-agent');
    expect(summarizationAgent.name).toBe('Summarization Agent');
  });
});
