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

  it('priorReviewContextがある場合、前回結果は参照情報として扱われ、差分集中指示がない', () => {
    const params = createTestParams({
      priorReviewContext: {
        results: [
          { checkItemContent: 'security check', ratingLabel: 'B', comment: 'Needs improvement' },
        ],
        commitMessages: ['fix: update auth logic'],
        diffSincePrior: '+ new cached response',
      },
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('Reference Only');
    expect(result).toContain('review the entire MR comprehensively');
    expect(result).not.toContain('Focus your analysis on changes since the prior review');
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

  it('activeSuggestsがある場合、Active Suggestionsセクションが含まれる', () => {
    const params = createTestParams({
      activeSuggests: [
        {
          checkItemContent: 'security check',
          filePath: 'src/auth.ts',
          originalCode: 'const password = input;',
          suggestedCode: 'const password = sanitize(input);',
          comment: 'Input should be sanitized',
        },
      ],
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('Active Suggestions from Prior Reviews');
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('security check');
    expect(result).toContain('const password = input;');
    expect(result).toContain('const password = sanitize(input);');
    expect(result).toContain('Do NOT generate suggestions with the same filePath and originalCode');
  });

  it('activeSuggestsがnullの場合、Active Suggestionsセクションが含まれない', () => {
    const params = createTestParams({
      activeSuggests: null,
    });

    const result = buildUserPromptTemplate(params);

    expect(result).not.toContain('Active Suggestions from Prior Reviews');
  });

  it('activeSuggestsが空配列の場合、Active Suggestionsセクションが含まれない', () => {
    const params = createTestParams({
      activeSuggests: [],
    });

    const result = buildUserPromptTemplate(params);

    expect(result).not.toContain('Active Suggestions from Prior Reviews');
  });

  it('activeSuggestsが未指定(undefined)の場合、Active Suggestionsセクションが含まれない', () => {
    const params = createTestParams();
    // activeSuggestsプロパティを指定しない

    const result = buildUserPromptTemplate(params);

    expect(result).not.toContain('Active Suggestions from Prior Reviews');
  });

  it('複数のactiveSuggestsがある場合、全てが含まれる', () => {
    const params = createTestParams({
      activeSuggests: [
        {
          checkItemContent: 'check1',
          filePath: 'src/a.ts',
          originalCode: 'code1',
          suggestedCode: 'fix1',
          comment: 'comment1',
        },
        {
          checkItemContent: 'check2',
          filePath: 'src/b.ts',
          originalCode: 'code2',
          suggestedCode: 'fix2',
          comment: 'comment2',
        },
      ],
    });

    const result = buildUserPromptTemplate(params);

    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/b.ts');
    expect(result).toContain('code1');
    expect(result).toContain('code2');
  });

  it('activeSuggestsセクションはpriorReviewセクションの後に配置される', () => {
    const params = createTestParams({
      priorReviewContext: {
        results: [{ checkItemContent: 'check1', ratingLabel: 'B', comment: 'ok' }],
        commitMessages: ['fix: something'],
        diffSincePrior: '+ new line',
      },
      activeSuggests: [
        {
          checkItemContent: 'check1',
          filePath: 'src/a.ts',
          originalCode: 'code1',
          suggestedCode: 'fix1',
          comment: 'comment1',
        },
      ],
    });

    const result = buildUserPromptTemplate(params);

    const priorIndex = result.indexOf('Prior Review Context');
    const suggestsIndex = result.indexOf('Active Suggestions from Prior Reviews');
    expect(priorIndex).toBeGreaterThan(-1);
    expect(suggestsIndex).toBeGreaterThan(-1);
    expect(suggestsIndex).toBeGreaterThan(priorIndex);
  });
});
