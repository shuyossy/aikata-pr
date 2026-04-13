import { describe, it, expect } from 'vitest';
import { buildGenerateOptions, createModelFromContext } from '../requestContext.js';
import type { WorkflowRequestContext } from '../requestContext.js';

function createTestContext(overrides?: Partial<WorkflowRequestContext>): WorkflowRequestContext {
  return {
    userId: 'test-user',
    projectId: 'test-project',
    aiApiKey: 'test-key',
    aiApiEndpointUrl: 'http://localhost',
    aiModelName: 'test-model',
    projectDir: '/test/project',
    openaiReasoningEffort: undefined,
    ...overrides,
  };
}

describe('buildGenerateOptions', () => {
  it('openaiReasoningEffortがundefinedの場合、空オブジェクトを返す', () => {
    const ctx = createTestContext({ openaiReasoningEffort: undefined });
    const result = buildGenerateOptions(ctx);
    expect(result).toEqual({});
  });

  it('openaiReasoningEffortが空文字列の場合、空オブジェクトを返す', () => {
    const ctx = createTestContext({ openaiReasoningEffort: '' });
    const result = buildGenerateOptions(ctx);
    expect(result).toEqual({});
  });

  it('openaiReasoningEffortが"low"の場合、modelSettingsとproviderOptionsを返す', () => {
    const ctx = createTestContext({ openaiReasoningEffort: 'low' });
    const result = buildGenerateOptions(ctx);
    expect(result).toEqual({
      modelSettings: { temperature: 1 },
      providerOptions: {
        openai: { reasoningEffort: 'low' },
      },
    });
  });

  it('openaiReasoningEffortが"high"の場合、正しい値を返す', () => {
    const ctx = createTestContext({ openaiReasoningEffort: 'high' });
    const result = buildGenerateOptions(ctx);
    expect(result).toEqual({
      modelSettings: { temperature: 1 },
      providerOptions: {
        openai: { reasoningEffort: 'high' },
      },
    });
  });
});

describe('createModelFromContext', () => {
  it('プロバイダ名が"openai"で作成される', () => {
    const ctx = createTestContext();
    const model = createModelFromContext(ctx);
    // modelIdにはプロバイダ名がプレフィックスとして含まれる
    expect(model.provider).toContain('openai');
  });
});
