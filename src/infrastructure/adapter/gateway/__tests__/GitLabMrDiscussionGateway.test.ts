import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitLabMrDiscussionGateway } from '../GitLabMrDiscussionGateway.js';

/**
 * GitLabApiClientのモックインターフェース
 */
interface MockGitLabApiClient {
  get: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

describe('GitLabMrDiscussionGateway', () => {
  let mockClient: MockGitLabApiClient;
  let gateway: GitLabMrDiscussionGateway;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      getAll: vi.fn(),
      post: vi.fn(),
    };
    gateway = new GitLabMrDiscussionGateway(
      mockClient as unknown as ConstructorParameters<typeof GitLabMrDiscussionGateway>[0],
    );
  });

  describe('getDiscussions', () => {
    it('Discussion一覧からnotes[0]を抽出してMrComment形式で返す', async () => {
      const discussionsResponse = [
        {
          id: 'disc-abc123',
          individual_note: false,
          notes: [
            { id: 1, body: 'First discussion body', created_at: '2026-03-01T00:00:00Z' },
            { id: 2, body: 'Reply to first', created_at: '2026-03-02T00:00:00Z' },
          ],
        },
        {
          id: 'disc-def456',
          individual_note: true,
          notes: [{ id: 3, body: 'Second discussion body', created_at: '2026-03-03T00:00:00Z' }],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussionsResponse);

      const result = await gateway.getDiscussions('123', '42');

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
          notes: [{ id: 5, body: 'Valid discussion', created_at: '2026-03-04T00:00:00Z' }],
        },
      ];

      mockClient.getAll.mockResolvedValueOnce(discussionsResponse);

      const result = await gateway.getDiscussions('456', '10');

      expect(result).toEqual([
        { id: 5, body: 'Valid discussion', createdAt: '2026-03-04T00:00:00Z' },
      ]);
    });

    it('Discussionが空の場合は空配列を返す', async () => {
      mockClient.getAll.mockResolvedValueOnce([]);

      const result = await gateway.getDiscussions('789', '1');

      expect(mockClient.getAll).toHaveBeenCalledWith('/projects/789/merge_requests/1/discussions');
      expect(result).toEqual([]);
    });
  });

  describe('postDiscussion', () => {
    it('POSTリクエストを/discussionsエンドポイントに送信する', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 'disc-new', notes: [{ id: 99 }] });

      await gateway.postDiscussion('123', '42', 'New discussion');

      // API呼び出しの検証
      expect(mockClient.post).toHaveBeenCalledWith('/projects/123/merge_requests/42/discussions', {
        body: 'New discussion',
      });
    });

    it('戻り値がvoidであること', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 'disc-100' });

      const result = await gateway.postDiscussion('789', '5', 'Another discussion');

      expect(result).toBeUndefined();
    });
  });
});
