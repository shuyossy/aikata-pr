import { describe, it, expect } from 'vitest';
import { MrContext } from '../MrContext.js';

describe('MrContext', () => {
  it('全てのフィールドを保持する', () => {
    const ctx = new MrContext({
      title: 'Fix bug',
      description: 'Bug fix description',
      sourceBranch: 'feature/fix',
      targetBranch: 'main',
      diff: '--- a/file\n+++ b/file',
      commitHash: 'abc1234',
      commitMessage: 'feat: add new feature',
      baseSha: 'base123',
      headSha: 'head456',
      startSha: 'start789',
    });
    expect(ctx.title).toBe('Fix bug');
    expect(ctx.description).toBe('Bug fix description');
    expect(ctx.sourceBranch).toBe('feature/fix');
    expect(ctx.targetBranch).toBe('main');
    expect(ctx.diff).toBe('--- a/file\n+++ b/file');
    expect(ctx.commitHash).toBe('abc1234');
    expect(ctx.commitMessage).toBe('feat: add new feature');
    expect(ctx.baseSha).toBe('base123');
    expect(ctx.headSha).toBe('head456');
    expect(ctx.startSha).toBe('start789');
  });
});
