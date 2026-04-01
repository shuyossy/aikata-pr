import { describe, it, expect } from 'vitest';
import { buildUserPromptTemplate } from '../UserPromptTemplate.js';
import type { UserPromptParams } from '../UserPromptTemplate.js';

function createTestParams(overrides?: Partial<UserPromptParams>): UserPromptParams {
  return {
    mrTitle: '',
    mrDescription: '',
    mrSourceBranch: '',
    mrTargetBranch: '',
    mrDiff: '',
    folderTree: '',
    priorReviewContext: null,
    checkItemCount: 0,
    ...overrides,
  };
}

describe('buildUserPromptTemplate', () => {
  it('MR情報（title, description, branches）が含まれる', () => {
    const params = createTestParams({
      mrTitle: 'Add login feature',
      mrDescription: 'Implements OAuth2 login',
      mrSourceBranch: 'feature/login',
      mrTargetBranch: 'main',
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('Add login feature');
    expect(result).toContain('Implements OAuth2 login');
    expect(result).toContain('feature/login');
    expect(result).toContain('main');
  });

  it('MRのdiffが含まれる', () => {
    const params = createTestParams({
      mrDiff: '+ added new line\n- removed old line',
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('+ added new line\n- removed old line');
  });

  it('priorReviewContextがnullの場合、Prior Reviewセクションが含まれない', () => {
    const params = createTestParams({
      priorReviewContext: null,
    });

    const result = buildUserPromptTemplate(params);

    expect(result).not.toContain('Prior Review');
    expect(result).not.toContain('Commits Since');
    expect(result).not.toContain('Previous Results');
  });

  it('priorReviewContextがある場合、コミットメッセージ・差分diff・前回結果が含まれる', () => {
    const params = createTestParams({
      priorReviewContext: {
        results: [
          { checkItemContent: 'security check', ratingLabel: 'B', comment: 'Needs improvement' },
          { checkItemContent: 'perf check', ratingLabel: 'A', comment: 'Good performance' },
        ],
        commitMessages: ['fix: update auth logic', 'feat: add caching'],
        diffSincePrior: '+ new cached response\n- old direct call',
      },
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('Prior Review');
    expect(result).toContain('fix: update auth logic');
    expect(result).toContain('feat: add caching');
    expect(result).toContain('+ new cached response');
    expect(result).toContain('security check');
    expect(result).toContain('Needs improvement');
    expect(result).toContain('perf check');
    expect(result).toContain('Good performance');
  });

  it('フォルダツリーが含まれる', () => {
    const params = createTestParams({
      folderTree: 'src/\n  domain/\n    CheckItem.ts\nREADME.md',
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('Project Folder Tree');
    expect(result).toContain('src/\n  domain/\n    CheckItem.ts\nREADME.md');
  });

  it('フォルダツリーセクションがMR Diffセクションの前に配置される', () => {
    const params = createTestParams({
      folderTree: 'src/\n  index.ts',
      mrDiff: '+ added line',
    });

    const result = buildUserPromptTemplate(params);

    const treeIndex = result.indexOf('Project Folder Tree');
    const diffIndex = result.indexOf('Merge Request Diff');
    expect(treeIndex).toBeGreaterThan(-1);
    expect(diffIndex).toBeGreaterThan(-1);
    expect(treeIndex).toBeLessThan(diffIndex);
  });

  it('チェック項目数が含まれる', () => {
    const params = createTestParams({
      checkItemCount: 3,
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('Review all 3 check items');
    expect(result).toContain('storeReviewResult');
  });

  it('フォルダツリーが空文字の場合、Folder Treeセクションが含まれない', () => {
    const params = createTestParams({
      folderTree: '',
    });

    const result = buildUserPromptTemplate(params);

    expect(result).not.toContain('Project Folder Tree');
  });
});
