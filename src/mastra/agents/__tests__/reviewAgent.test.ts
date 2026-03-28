import { describe, it, expect } from 'vitest';
import { Workspace } from '@mastra/core/workspace';
import { RequestContext } from '@mastra/core/request-context';
import { createWorkspaceFromContext, buildInstructions, buildUserPrompt } from '../reviewAgent.js';
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
    folderTree: '',
    ...overrides,
  };
}

/**
 * テスト用のRequestContextを生成するヘルパー
 */
function createTestRequestContext(
  overrides?: Partial<ReviewAgentRequestContext>,
): RequestContext<ReviewAgentRequestContext> {
  const ctx = createTestContext(overrides);
  return new RequestContext<ReviewAgentRequestContext>([
    ['userId', ctx.userId],
    ['aiApiKey', ctx.aiApiKey],
    ['aiApiEndpointUrl', ctx.aiApiEndpointUrl],
    ['aiModelName', ctx.aiModelName],
    ['projectDir', ctx.projectDir],
    ['checkItems', ctx.checkItems],
    ['ratings', ctx.ratings],
    ['commentFormat', ctx.commentFormat],
    ['additionalInstructions', ctx.additionalInstructions],
    ['mrTitle', ctx.mrTitle],
    ['mrDescription', ctx.mrDescription],
    ['mrSourceBranch', ctx.mrSourceBranch],
    ['mrTargetBranch', ctx.mrTargetBranch],
    ['mrDiff', ctx.mrDiff],
    ['priorReviewContext', ctx.priorReviewContext],
    ['skillsPaths', ctx.skillsPaths],
    ['folderTree', ctx.folderTree],
  ]);
}

describe('buildInstructions', () => {
  it('チェック項目がsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      checkItems: [
        { id: 1, content: 'security check' },
        { id: 2, content: 'performance check' },
      ],
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('[ID: 1] security check');
    expect(result).toContain('[ID: 2] performance check');
  });

  it('評定基準がsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      ratings: [
        { label: 'A', definition: 'Fully satisfies requirements' },
        { label: 'C', definition: 'Does not satisfy requirements' },
      ],
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('A: Fully satisfies requirements');
    expect(result).toContain('C: Does not satisfy requirements');
  });

  it('コメントフォーマットがsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      commentFormat: '## Review\n{comment}',
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('## Review\n{comment}');
  });

  it('ReActフレームワーク（REASON, ACT, OBSERVE）が含まれる', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    expect(result).toContain('REASON');
    expect(result).toContain('ACT');
    expect(result).toContain('OBSERVE');
    expect(result).toMatch(/Reasoning Framework.*ReAct/);
  });

  it('ツールリファレンスが含まれる', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    expect(result).toContain('storeReviewResult');
    expect(result).toContain('getReviewResults');
    expect(result).toMatch(/Workspace/i);
  });

  it('完了要件が含まれる', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    expect(result).toMatch(/MUST review/i);
    expect(result).toMatch(/Do NOT finish/i);
  });

  it('MR情報（title, description, branches, diff）がsystemプロンプトに含まれない', () => {
    const requestContext = createTestRequestContext({
      mrTitle: 'UNIQUE_MR_TITLE',
      mrDescription: 'UNIQUE_MR_DESCRIPTION',
      mrSourceBranch: 'feature/unique-branch',
      mrTargetBranch: 'main-unique-target',
      mrDiff: 'UNIQUE_DIFF_CONTENT_HERE',
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('UNIQUE_MR_TITLE');
    expect(result).not.toContain('UNIQUE_MR_DESCRIPTION');
    expect(result).not.toContain('feature/unique-branch');
    expect(result).not.toContain('main-unique-target');
    expect(result).not.toContain('UNIQUE_DIFF_CONTENT_HERE');
  });

  it('過去のチェック結果がsystemプロンプトに含まれない', () => {
    const requestContext = createTestRequestContext({
      priorReviewContext: {
        results: [
          { checkItemContent: 'check1', ratingLabel: 'B', comment: 'UNIQUE_PRIOR_COMMENT' },
        ],
        commitMessages: ['UNIQUE_PRIOR_COMMIT'],
        diffSincePrior: 'UNIQUE_PRIOR_DIFF',
      },
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('UNIQUE_PRIOR_COMMENT');
    expect(result).not.toContain('UNIQUE_PRIOR_COMMIT');
    expect(result).not.toContain('UNIQUE_PRIOR_DIFF');
  });

  it('additionalInstructionsが非空の場合、Additional Instructionsセクションが含まれる', () => {
    const requestContext = createTestRequestContext({
      additionalInstructions: 'Focus on security vulnerabilities',
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('Additional Instructions');
    expect(result).toContain('Focus on security vulnerabilities');
  });

  it('additionalInstructionsが空の場合、Additional Instructionsセクションが含まれない', () => {
    const requestContext = createTestRequestContext({
      additionalInstructions: '',
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('Additional Instructions');
  });
});

describe('buildUserPrompt', () => {
  it('MR情報（title, description, branches）がuserプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      mrTitle: 'Add login feature',
      mrDescription: 'Implements OAuth2 login',
      mrSourceBranch: 'feature/login',
      mrTargetBranch: 'main',
    });

    const result = buildUserPrompt(requestContext, '/tmp/results.json');

    expect(result).toContain('Add login feature');
    expect(result).toContain('Implements OAuth2 login');
    expect(result).toContain('feature/login');
    expect(result).toContain('main');
  });

  it('MRのdiffがuserプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      mrDiff: '+ added new line\n- removed old line',
    });

    const result = buildUserPrompt(requestContext, '/tmp/results.json');

    expect(result).toContain('+ added new line\n- removed old line');
  });

  it('resultFilePathがuserプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext();

    const result = buildUserPrompt(requestContext, '/tmp/test-results.json');

    expect(result).toContain('/tmp/test-results.json');
  });

  it('priorReviewContextがnullの場合、Prior Reviewセクションが含まれない', () => {
    const requestContext = createTestRequestContext({
      priorReviewContext: null,
    });

    const result = buildUserPrompt(requestContext, '/tmp/results.json');

    expect(result).not.toContain('Prior Review');
    expect(result).not.toContain('Commits Since');
    expect(result).not.toContain('Previous Results');
  });

  it('priorReviewContextがある場合、コミットメッセージ・差分diff・前回結果が含まれる', () => {
    const requestContext = createTestRequestContext({
      priorReviewContext: {
        results: [
          { checkItemContent: 'security check', ratingLabel: 'B', comment: 'Needs improvement' },
          { checkItemContent: 'perf check', ratingLabel: 'A', comment: 'Good performance' },
        ],
        commitMessages: ['fix: update auth logic', 'feat: add caching'],
        diffSincePrior: '+ new cached response\n- old direct call',
      },
    });

    const result = buildUserPrompt(requestContext, '/tmp/results.json');

    expect(result).toContain('Prior Review');
    expect(result).toContain('fix: update auth logic');
    expect(result).toContain('feat: add caching');
    expect(result).toContain('+ new cached response');
    expect(result).toContain('security check');
    expect(result).toContain('Needs improvement');
    expect(result).toContain('perf check');
    expect(result).toContain('Good performance');
  });

  it('フォルダツリーがuserプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      folderTree: 'src/\n  domain/\n    CheckItem.ts\nREADME.md',
    });

    const result = buildUserPrompt(requestContext, '/tmp/results.json');

    expect(result).toContain('Project Folder Tree');
    expect(result).toContain('src/\n  domain/\n    CheckItem.ts\nREADME.md');
  });

  it('フォルダツリーセクションがMR Diffセクションの前に配置される', () => {
    const requestContext = createTestRequestContext({
      folderTree: 'src/\n  index.ts',
      mrDiff: '+ added line',
    });

    const result = buildUserPrompt(requestContext, '/tmp/results.json');

    const treeIndex = result.indexOf('Project Folder Tree');
    const diffIndex = result.indexOf('Merge Request Diff');
    expect(treeIndex).toBeGreaterThan(-1);
    expect(diffIndex).toBeGreaterThan(-1);
    expect(treeIndex).toBeLessThan(diffIndex);
  });

  it('チェック項目数がuserプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      checkItems: [
        { id: 1, content: 'item1' },
        { id: 2, content: 'item2' },
        { id: 3, content: 'item3' },
      ],
    });

    const result = buildUserPrompt(requestContext, '/tmp/results.json');

    expect(result).toContain('3');
    expect(result).toContain('storeReviewResult');
  });
});

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
