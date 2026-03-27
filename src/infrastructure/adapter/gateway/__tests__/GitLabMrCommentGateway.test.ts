import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitLabMrCommentGateway } from '../GitLabMrCommentGateway.js';

/**
 * GitLabApiClientのモックインターフェース
 */
interface MockGitLabApiClient {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

describe('GitLabMrCommentGateway', () => {
  let mockClient: MockGitLabApiClient;
  let gateway: GitLabMrCommentGateway;

  beforeEach(() => {
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
    };
    gateway = new GitLabMrCommentGateway(
      mockClient as unknown as ConstructorParameters<typeof GitLabMrCommentGateway>[0],
    );
  });

  describe('getComments', () => {
    it('ノート一覧をMrComment形式で返す', async () => {
      const notesResponse = [
        { id: 1, body: 'First comment', created_at: '2026-03-01T00:00:00Z' },
        { id: 2, body: 'Second comment', created_at: '2026-03-02T00:00:00Z' },
      ];

      mockClient.get.mockResolvedValueOnce(notesResponse);

      const result = await gateway.getComments('123', '42');

      // API呼び出しの検証
      expect(mockClient.get).toHaveBeenCalledWith('/api/v4/projects/123/merge_requests/42/notes');

      // マッピング結果の検証
      expect(result).toEqual([
        { id: 1, body: 'First comment', createdAt: '2026-03-01T00:00:00Z' },
        { id: 2, body: 'Second comment', createdAt: '2026-03-02T00:00:00Z' },
      ]);
    });

    it('ノートが空の場合は空配列を返す', async () => {
      mockClient.get.mockResolvedValueOnce([]);

      const result = await gateway.getComments('456', '10');

      expect(mockClient.get).toHaveBeenCalledWith('/api/v4/projects/456/merge_requests/10/notes');
      expect(result).toEqual([]);
    });
  });

  describe('postComment', () => {
    it('POSTリクエストを送信する', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 99, body: 'New comment' });

      await gateway.postComment('123', '42', 'New comment');

      // API呼び出しの検証
      expect(mockClient.post).toHaveBeenCalledWith('/api/v4/projects/123/merge_requests/42/notes', {
        body: 'New comment',
      });
    });

    it('戻り値がvoidであること', async () => {
      mockClient.post.mockResolvedValueOnce({ id: 100, body: 'Another comment' });

      const result = await gateway.postComment('789', '5', 'Another comment');

      expect(result).toBeUndefined();
    });
  });
});
