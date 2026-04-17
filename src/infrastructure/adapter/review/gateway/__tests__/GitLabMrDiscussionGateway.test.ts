import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitLabMrDiscussionGateway } from '../GitLabMrDiscussionGateway.js';

/**
 * GitLabApiClientのモックインターフェース
 */
interface MockGitLabApiClient {
  get: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

describe('GitLabMrDiscussionGateway', () => {
  let mockClient: MockGitLabApiClient;
  let gateway: GitLabMrDiscussionGateway;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      getAll: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
    };
    gateway = new GitLabMrDiscussionGateway(
      mockClient as unknown as ConstructorParameters<typeof GitLabMrDiscussionGateway>[0],
    );
  });

  describe('getReviewDiscussions', () => {
    it('Discussion一覧からnotes[0]を抽出してMrComment形式で返す', async () => {
      const discussionsResponse = [
        {
          id: 'disc-abc123',
          individual_note: false,
          notes: [
            {
              id: 1,
              body: 'First discussion body',
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
            {
              id: 2,
              body: 'Reply to first',
              created_at: '2026-03-02T00:00:00Z',
              system: false,
            },
          ],
        },
        {
          id: 'disc-def456',
          individual_note: true,
          notes: [
            {
              id: 3,
              body: 'Second discussion body',
              created_at: '2026-03-03T00:00:00Z',
              system: false,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussionsResponse);

      const result = await gateway.getReviewDiscussions('123', '42');

      // API呼び出しの検証
      expect(mockClient.getAll).toHaveBeenCalledWith('/projects/123/merge_requests/42/discussions');

      // notes[0]のみ抽出されること
      expect(result).toEqual([
        { id: 1, body: 'First discussion body', createdAt: '2026-03-01T00:00:00Z' },
        { id: 3, body: 'Second discussion body', createdAt: '2026-03-03T00:00:00Z' },
      ]);
    });

    it('notes配列が空のdiscussionはスキップする', async () => {
      const discussionsResponse = [
        {
          id: 'disc-empty',
          individual_note: false,
          notes: [],
        },
        {
          id: 'disc-valid',
          individual_note: false,
          notes: [
            {
              id: 5,
              body: 'Valid discussion',
              created_at: '2026-03-04T00:00:00Z',
              system: false,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussionsResponse);

      const result = await gateway.getReviewDiscussions('456', '10');

      expect(result).toEqual([
        { id: 5, body: 'Valid discussion', createdAt: '2026-03-04T00:00:00Z' },
      ]);
    });

    it('Discussionが空の場合は空配列を返す', async () => {
      mockClient.getAll.mockResolvedValueOnce([]);

      const result = await gateway.getReviewDiscussions('789', '1');

      expect(mockClient.getAll).toHaveBeenCalledWith('/projects/789/merge_requests/1/discussions');
      expect(result).toEqual([]);
    });
  });

  describe('postReviewDiscussion', () => {
    it('POSTリクエストを/discussionsエンドポイントに送信する', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 'disc-new', notes: [{ id: 99 }] });

      await gateway.postReviewDiscussion('123', '42', 'New discussion');

      // API呼び出しの検証
      expect(mockClient.post).toHaveBeenCalledWith('/projects/123/merge_requests/42/discussions', {
        body: 'New discussion',
      });
    });

    it('戻り値がvoidであること', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 'disc-100' });

      const result = await gateway.postReviewDiscussion('789', '5', 'Another discussion');

      expect(result).toBeUndefined();
    });
  });

  describe('postNote', () => {
    it('POSTリクエストを/notesエンドポイントに送信する', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 99 });

      await gateway.postNote('123', '42', 'Note body');

      expect(mockClient.post).toHaveBeenCalledWith('/projects/123/merge_requests/42/notes', {
        body: 'Note body',
      });
    });

    it('戻り値がvoidであること', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 100 });

      const result = await gateway.postNote('789', '5', 'Another note');

      expect(result).toBeUndefined();
    });
  });

  describe('getSuggestDiscussions', () => {
    it('suggestマーカーを持つディスカッションがない場合は空配列を返す', async () => {
      const discussions = [
        {
          id: 'disc-1',
          individual_note: false,
          notes: [
            {
              id: 1,
              body: 'Regular discussion comment',
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
          ],
        },
        {
          id: 'disc-2',
          individual_note: false,
          notes: [
            {
              id: 2,
              body: '<!-- aikata-review -->Some review comment',
              created_at: '2026-03-02T00:00:00Z',
              system: false,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(mockClient.getAll).toHaveBeenCalledWith('/projects/123/merge_requests/42/discussions');
      expect(result).toEqual([]);
    });

    it('suggestマーカーとメタデータを持つディスカッションを正しくパースする', async () => {
      const suggestData = JSON.stringify({
        checkItemContent: 'Check null handling',
        filePath: 'src/main.ts',
        originalCode: 'if (x) { ... }',
        suggestedCode: 'if (x != null) { ... }',
      });
      const discussions = [
        {
          id: 'disc-suggest-1',
          individual_note: false,
          notes: [
            {
              id: 10,
              body: `<!-- aikata-suggest -->\n<!-- aikata-suggest-data: ${suggestData} -->\nSuggestion body`,
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(result).toEqual([
        {
          discussionId: 'disc-suggest-1',
          checkItemContent: 'Check null handling',
          filePath: 'src/main.ts',
          originalCode: 'if (x) { ... }',
          suggestedCode: 'if (x != null) { ... }',
          hasChangedSinceNote: false,
        },
      ]);
    });

    it('system noteに"changed this line"が含まれる場合、hasChangedSinceNoteがtrueになる', async () => {
      const suggestData = JSON.stringify({
        checkItemContent: 'Check error handling',
        filePath: 'src/error.ts',
        suggestedCode: 'throw new Error("msg")',
      });
      const discussions = [
        {
          id: 'disc-changed',
          individual_note: false,
          notes: [
            {
              id: 20,
              body: `<!-- aikata-suggest -->\n<!-- aikata-suggest-data: ${suggestData} -->\nSuggestion`,
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
            {
              id: 21,
              body: 'changed this line in commit abc123',
              created_at: '2026-03-02T00:00:00Z',
              system: true,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(result).toHaveLength(1);
      expect(result[0].hasChangedSinceNote).toBe(true);
    });

    it('system noteがない場合、hasChangedSinceNoteがfalseになる', async () => {
      const suggestData = JSON.stringify({
        checkItemContent: 'Check logging',
        filePath: 'src/logger.ts',
        suggestedCode: 'console.log("debug")',
      });
      const discussions = [
        {
          id: 'disc-no-change',
          individual_note: false,
          notes: [
            {
              id: 30,
              body: `<!-- aikata-suggest -->\n<!-- aikata-suggest-data: ${suggestData} -->\nSuggestion`,
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
            {
              id: 31,
              body: 'Normal reply from user',
              created_at: '2026-03-02T00:00:00Z',
              system: false,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(result).toHaveLength(1);
      expect(result[0].hasChangedSinceNote).toBe(false);
    });

    it('suggestでないディスカッション（aikata-reviewを含む）を無視する', async () => {
      const suggestData = JSON.stringify({
        checkItemContent: 'Valid check',
        filePath: 'src/valid.ts',
        suggestedCode: 'return true;',
      });
      const discussions = [
        {
          id: 'disc-review',
          individual_note: false,
          notes: [
            {
              id: 40,
              body: '<!-- aikata-review -->Review comment',
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
          ],
        },
        {
          id: 'disc-regular',
          individual_note: false,
          notes: [
            {
              id: 41,
              body: 'Just a plain comment',
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
          ],
        },
        {
          id: 'disc-suggest',
          individual_note: false,
          notes: [
            {
              id: 42,
              body: `<!-- aikata-suggest -->\n<!-- aikata-suggest-data: ${suggestData} -->\nSuggestion`,
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(result).toHaveLength(1);
      expect(result[0].discussionId).toBe('disc-suggest');
    });

    it('複数のsuggestディスカッションを処理できる', async () => {
      const suggestData1 = JSON.stringify({
        checkItemContent: 'Check 1',
        filePath: 'src/a.ts',
        suggestedCode: 'code 1',
      });
      const suggestData2 = JSON.stringify({
        checkItemContent: 'Check 2',
        filePath: 'src/b.ts',
        suggestedCode: 'code 2',
      });
      const discussions = [
        {
          id: 'disc-s1',
          individual_note: false,
          notes: [
            {
              id: 50,
              body: `<!-- aikata-suggest -->\n<!-- aikata-suggest-data: ${suggestData1} -->\nSuggestion 1`,
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
          ],
        },
        {
          id: 'disc-s2',
          individual_note: false,
          notes: [
            {
              id: 51,
              body: `<!-- aikata-suggest -->\n<!-- aikata-suggest-data: ${suggestData2} -->\nSuggestion 2`,
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
            {
              id: 52,
              body: 'compare changes',
              created_at: '2026-03-02T00:00:00Z',
              system: true,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        discussionId: 'disc-s1',
        checkItemContent: 'Check 1',
        filePath: 'src/a.ts',
        originalCode: '',
        suggestedCode: 'code 1',
        hasChangedSinceNote: false,
      });
      expect(result[1]).toEqual({
        discussionId: 'disc-s2',
        checkItemContent: 'Check 2',
        filePath: 'src/b.ts',
        originalCode: '',
        suggestedCode: 'code 2',
        hasChangedSinceNote: true,
      });
    });

    it('"changed this"キーワードでもhasChangedSinceNoteがtrueになる', async () => {
      const suggestData = JSON.stringify({
        checkItemContent: 'Check',
        filePath: 'src/x.ts',
        suggestedCode: 'code',
      });
      const discussions = [
        {
          id: 'disc-changed2',
          individual_note: false,
          notes: [
            {
              id: 60,
              body: `<!-- aikata-suggest -->\n<!-- aikata-suggest-data: ${suggestData} -->\nSuggestion`,
              created_at: '2026-03-01T00:00:00Z',
              system: false,
            },
            {
              id: 61,
              body: 'changed this in commit def456',
              created_at: '2026-03-02T00:00:00Z',
              system: true,
            },
          ],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(result[0].hasChangedSinceNote).toBe(true);
    });

    it('notes配列が空のディスカッションをスキップする', async () => {
      const discussions = [
        {
          id: 'disc-empty',
          individual_note: false,
          notes: [],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussions);

      const result = await gateway.getSuggestDiscussions('123', '42');

      expect(result).toEqual([]);
    });
  });

  describe('postSuggestDiscussion', () => {
    it('正しいエンドポイントとpositionデータでPOSTリクエストを送信する', async () => {
      mockClient.post.mockResolvedValueOnce({
        id: 'disc-new',
        notes: [{ id: 99 }],
      });

      const position = {
        baseSha: 'abc123',
        headSha: 'def456',
        startSha: 'ghi789',
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
        newLine: 42,
      };

      await gateway.postSuggestDiscussion('123', '42', 'Suggest body', position);

      expect(mockClient.post).toHaveBeenCalledWith('/projects/123/merge_requests/42/discussions', {
        body: 'Suggest body',
        position: {
          position_type: 'text',
          base_sha: 'abc123',
          head_sha: 'def456',
          start_sha: 'ghi789',
          old_path: 'src/old.ts',
          new_path: 'src/new.ts',
          new_line: 42,
        },
      });
    });

    it('戻り値がvoidであること', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 'disc-200' });

      const position = {
        baseSha: 'a',
        headSha: 'b',
        startSha: 'c',
        oldPath: 'x.ts',
        newPath: 'x.ts',
        newLine: 1,
      };

      const result = await gateway.postSuggestDiscussion('123', '42', 'body', position);

      expect(result).toBeUndefined();
    });
  });

  describe('resolveDiscussion', () => {
    it('正しいエンドポイントとresolved: trueでPUTリクエストを送信する', async () => {
      mockClient.put.mockResolvedValueOnce({ id: 'disc-1', resolved: true });

      await gateway.resolveDiscussion('123', '42', 'disc-resolve-1');

      expect(mockClient.put).toHaveBeenCalledWith(
        '/projects/123/merge_requests/42/discussions/disc-resolve-1',
        { resolved: true },
      );
    });

    it('戻り値がvoidであること', async () => {
      mockClient.put.mockResolvedValueOnce({ id: 'disc-2', resolved: true });

      const result = await gateway.resolveDiscussion('789', '5', 'disc-resolve-2');

      expect(result).toBeUndefined();
    });
  });
});
