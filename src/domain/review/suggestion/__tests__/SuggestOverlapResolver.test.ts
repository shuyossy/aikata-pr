import { describe, it, expect } from 'vitest';
import {
  resolveOverlappingSuggests,
  type PriorSuggestLineRange,
  type SuggestLineRange,
} from '../SuggestOverlapResolver.js';

describe('resolveOverlappingSuggests', () => {
  describe('重複なし', () => {
    it('空配列の場合は空結果を返す', () => {
      const result = resolveOverlappingSuggests([], []);
      expect(result).toEqual([]);
    });

    it('新suggestが空の場合は空結果を返す', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 1, endLine: 5 },
      ];
      const result = resolveOverlappingSuggests(priors, []);
      expect(result).toEqual([]);
    });

    it('以前のsuggestが空の場合は空結果を返す', () => {
      const newSuggests: SuggestLineRange[] = [{ filePath: 'a.ts', startLine: 1, endLine: 5 }];
      const result = resolveOverlappingSuggests([], newSuggests);
      expect(result).toEqual([]);
    });

    it('異なるファイルの場合は重複しない', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 1, endLine: 5 },
      ];
      const newSuggests: SuggestLineRange[] = [{ filePath: 'b.ts', startLine: 1, endLine: 5 }];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual([]);
    });

    it('同一ファイルで隣接（非重複）の場合は重複しない', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 1, endLine: 5 },
      ];
      const newSuggests: SuggestLineRange[] = [{ filePath: 'a.ts', startLine: 6, endLine: 10 }];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual([]);
    });
  });

  describe('重複あり', () => {
    it('同一ファイルで1行重複を検出する', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 1, endLine: 5 },
      ];
      const newSuggests: SuggestLineRange[] = [{ filePath: 'a.ts', startLine: 5, endLine: 10 }];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual(['d1']);
    });

    it('同一ファイルで完全包含を検出する', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 3, endLine: 7 },
      ];
      const newSuggests: SuggestLineRange[] = [{ filePath: 'a.ts', startLine: 1, endLine: 10 }];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual(['d1']);
    });

    it('同一ファイルで部分重複を検出する', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 3, endLine: 7 },
      ];
      const newSuggests: SuggestLineRange[] = [{ filePath: 'a.ts', startLine: 5, endLine: 12 }];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual(['d1']);
    });

    it('単一行のsuggest同士が同一行で重複を検出する', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 5, endLine: 5 },
      ];
      const newSuggests: SuggestLineRange[] = [{ filePath: 'a.ts', startLine: 5, endLine: 5 }];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual(['d1']);
    });
  });

  describe('複数suggest', () => {
    it('複数の新suggestが同一の以前suggestに重複しても1回だけ返す', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 5, endLine: 15 },
      ];
      const newSuggests: SuggestLineRange[] = [
        { filePath: 'a.ts', startLine: 1, endLine: 6 },
        { filePath: 'a.ts', startLine: 10, endLine: 20 },
      ];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual(['d1']);
    });

    it('複数の以前suggestのうち重複するものだけ返す', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 1, endLine: 5 },
        { discussionId: 'd2', filePath: 'a.ts', startLine: 10, endLine: 15 },
        { discussionId: 'd3', filePath: 'b.ts', startLine: 1, endLine: 5 },
      ];
      const newSuggests: SuggestLineRange[] = [{ filePath: 'a.ts', startLine: 4, endLine: 8 }];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual(['d1']);
    });

    it('複数ファイルにまたがる重複を正しく検出する', () => {
      const priors: PriorSuggestLineRange[] = [
        { discussionId: 'd1', filePath: 'a.ts', startLine: 1, endLine: 5 },
        { discussionId: 'd2', filePath: 'b.ts', startLine: 10, endLine: 15 },
      ];
      const newSuggests: SuggestLineRange[] = [
        { filePath: 'a.ts', startLine: 3, endLine: 8 },
        { filePath: 'b.ts', startLine: 12, endLine: 20 },
      ];
      const result = resolveOverlappingSuggests(priors, newSuggests);
      expect(result).toEqual(expect.arrayContaining(['d1', 'd2']));
      expect(result).toHaveLength(2);
    });
  });
});
