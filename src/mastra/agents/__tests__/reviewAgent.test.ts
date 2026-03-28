import { describe, it, expect } from 'vitest';
import { Workspace } from '@mastra/core/workspace';
import { createWorkspaceFromContext } from '../reviewAgent.js';
import type { ReviewAgentRequestContext } from '../../requestContext.js';

/**
 * テスト用のReviewAgentRequestContextを生成するヘルパー
 */
function createTestContext(
  overrides?: Partial<ReviewAgentRequestContext>,
): ReviewAgentRequestContext {
  return {
    userId: 'test-user',
    aiApiKey: 'test-key',
    aiApiEndpointUrl: 'http://localhost',
    aiModelName: 'test-model',
    projectDir: '/test/project',
    checkItems: [],
    ratings: [],
    commentFormat: '',
    additionalInstructions: '',
    mrTitle: '',
    mrDescription: '',
    mrSourceBranch: '',
    mrTargetBranch: '',
    mrDiff: '',
    priorReviewContext: null,
    skillsPaths: [],
    ...overrides,
  };
}

describe('createWorkspaceFromContext', () => {
  it('Workspaceインスタンスを生成する', () => {
    const ctx = createTestContext({ projectDir: '/my/project' });
    const workspace = createWorkspaceFromContext(ctx);
    expect(workspace).toBeInstanceOf(Workspace);
  });

  it('skillsPathsが空の場合、skillsはundefinedになる', () => {
    const ctx = createTestContext({ skillsPaths: [] });
    const workspace = createWorkspaceFromContext(ctx);
    // Workspaceのskillsプロパティはskillsが未設定の場合undefined
    expect(workspace.skills).toBeUndefined();
  });

  it('skillsPathsが指定されている場合、skillsが設定される', () => {
    const ctx = createTestContext({ skillsPaths: ['/path/to/skills'] });
    const workspace = createWorkspaceFromContext(ctx);
    // skillsが設定されている場合、WorkspaceSkillsインスタンスが存在する
    expect(workspace.skills).toBeDefined();
  });
});
