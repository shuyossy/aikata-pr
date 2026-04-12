import { describe, it, expect } from 'vitest';
import type { ArtifactEntry } from '../ArtifactEntry.js';
import { ArtifactTree } from '../ArtifactTree.js';

describe('ArtifactTree', () => {
  it('ofで渡したentriesを保持する', () => {
    const entries: ArtifactEntry[] = [
      { path: 'dist/index.js', type: 'file', size: 1024, mode: '100644' },
      { path: 'dist', type: 'tree', size: 0, mode: '040755' },
    ];

    const tree = ArtifactTree.of({ jobId: 1, jobName: 'build', entries });

    expect(tree.jobId).toBe(1);
    expect(tree.jobName).toBe('build');
    expect(tree.entries).toHaveLength(2);
    expect(tree.entries[0]).toEqual(entries[0]);
  });

  it('入力entriesの変更が内部状態に影響しない（防御的コピー）', () => {
    const entries: ArtifactEntry[] = [{ path: 'a.txt', type: 'file', size: 10, mode: '100644' }];
    const tree = ArtifactTree.of({ jobId: 1, jobName: 'build', entries });
    entries.push({ path: 'b.txt', type: 'file', size: 20, mode: '100644' });

    expect(tree.entries).toHaveLength(1);
  });

  it('filePathsはtypeがfileのpathのみを返す', () => {
    const tree = ArtifactTree.of({
      jobId: 1,
      jobName: 'build',
      entries: [
        { path: 'dist/index.js', type: 'file', size: 1, mode: '100644' },
        { path: 'dist', type: 'tree', size: 0, mode: '040755' },
        { path: 'dist/meta.json', type: 'file', size: 1, mode: '100644' },
      ],
    });

    expect(tree.filePaths()).toEqual(['dist/index.js', 'dist/meta.json']);
  });

  it('emptyは空のentriesを持つ', () => {
    const tree = ArtifactTree.empty(5, 'test');
    expect(tree.jobId).toBe(5);
    expect(tree.jobName).toBe('test');
    expect(tree.entries).toEqual([]);
    expect(tree.filePaths()).toEqual([]);
  });
});
