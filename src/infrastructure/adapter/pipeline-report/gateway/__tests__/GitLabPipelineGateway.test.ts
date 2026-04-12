import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitLabApiClient } from '../../../httpClient/GitLabApiClient.js';
import { GitLabPipelineGateway } from '../GitLabPipelineGateway.js';

/**
 * GitLabPipelineGateway のテスト
 * 実装の `GitLabApiClient` と組み合わせ、`global.fetch` をスタブしてリクエスト URL / ヘッダ
 * / レスポンス変換を検証する。
 */
describe('GitLabPipelineGateway', () => {
  const mockFetch = vi.fn();
  const baseUrl = 'https://gitlab.example.com/api/v4';
  const token = 'test-token';

  let client: GitLabApiClient;
  let gateway: GitLabPipelineGateway;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    client = new GitLabApiClient(baseUrl, token);
    gateway = new GitLabPipelineGateway(client);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ヘルパー: 成功 JSON レスポンスを生成
  const jsonResponse = (body: unknown, headers: Record<string, string> = {}) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  });

  // ヘルパー: プレーンテキストレスポンスを生成
  const textResponse = (body: string) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(body),
    headers: { get: () => null },
  });

  // ヘルパー: ReadableStream 付きのバイナリレスポンスを生成
  const streamResponse = (chunks: Uint8Array[]) => {
    // Web ReadableStream を直接生成することで Node Readable との変換ブリッジを回避
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: webStream,
      headers: { get: () => null },
    };
  };

  // ヘルパー: エラーレスポンスを生成
  const errorResponse = (status: number, statusText: string) => ({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    headers: { get: () => null },
  });

  describe('getPipeline', () => {
    it('GitLab JSON を Pipeline entity に変換する', async () => {
      const gitlabPipeline = {
        id: 5501,
        project_id: 42,
        sha: 'abc123def456',
        ref: 'main',
        status: 'failed',
        web_url: 'https://gitlab.example.com/group/proj/-/pipelines/5501',
        created_at: '2026-04-11T10:00:00Z',
        updated_at: '2026-04-11T10:15:00Z',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(gitlabPipeline));

      const pipeline = await gateway.getPipeline(42, 5501);

      // リクエスト URL とヘッダの検証
      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/pipelines/5501',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );

      // 変換結果の検証
      expect(pipeline.projectId).toBe(42);
      expect(pipeline.pipelineId).toBe(5501);
      expect(pipeline.ref).toBe('main');
      expect(pipeline.sha).toBe('abc123def456');
      expect(pipeline.status).toBe('failed');
      expect(pipeline.webUrl).toBe('https://gitlab.example.com/group/proj/-/pipelines/5501');
      expect(pipeline.createdAt).toBeInstanceOf(Date);
      expect(pipeline.createdAt.toISOString()).toBe('2026-04-11T10:00:00.000Z');
      expect(pipeline.updatedAt).toBeInstanceOf(Date);
      expect(pipeline.updatedAt.toISOString()).toBe('2026-04-11T10:15:00.000Z');
    });

    it('HTTPエラーの場合、エラーを伝播する', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

      await expect(gateway.getPipeline(42, 9999)).rejects.toThrow(
        'GitLab API error: 404 Not Found',
      );
    });
  });

  describe('getJobs', () => {
    // ヘルパー: ページレスポンス生成 (Linkヘッダ付き)
    const pageResponse = (body: unknown[], nextUrl: string | null) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
      headers: {
        get: (name: string) => {
          if (name === 'link' && nextUrl) {
            return `<${nextUrl}>; rel="next"`;
          }
          return null;
        },
      },
    });

    it('単ページのジョブ一覧を Job entity 配列に変換する', async () => {
      const jobs = [
        {
          id: 1001,
          name: 'build',
          stage: 'build',
          status: 'success',
          started_at: '2026-04-11T10:00:00Z',
          finished_at: '2026-04-11T10:05:00Z',
          duration: 300,
          web_url: 'https://gitlab.example.com/group/proj/-/jobs/1001',
          failure_reason: null,
          artifacts_file: { size: 2048 },
        },
      ];
      mockFetch.mockResolvedValueOnce(pageResponse(jobs, null));

      const result = await gateway.getJobs(42, 5501, { includeRetried: false });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/pipelines/5501/jobs?include_retried=false&per_page=100',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1001);
      expect(result[0].name).toBe('build');
      expect(result[0].stage).toBe('build');
      expect(result[0].status).toBe('success');
      expect(result[0].startedAt?.toISOString()).toBe('2026-04-11T10:00:00.000Z');
      expect(result[0].finishedAt?.toISOString()).toBe('2026-04-11T10:05:00.000Z');
      expect(result[0].duration).toBe(300);
      expect(result[0].webUrl).toBe('https://gitlab.example.com/group/proj/-/jobs/1001');
      expect(result[0].failureReason).toBeNull();
      expect(result[0].hasArtifacts).toBe(true);
      expect(result[0].artifactsSize).toBe(2048);
    });

    it('複数ページをページネーション結合する', async () => {
      const nextUrl =
        'https://gitlab.example.com/api/v4/projects/42/pipelines/5501/jobs?include_retried=false&per_page=100&page=2';
      mockFetch
        .mockResolvedValueOnce(
          pageResponse(
            [
              {
                id: 1,
                name: 'job-a',
                stage: 'test',
                status: 'success',
                started_at: '2026-04-11T10:00:00Z',
                finished_at: '2026-04-11T10:01:00Z',
                duration: 60,
                web_url: 'https://gitlab.example.com/group/proj/-/jobs/1',
                failure_reason: null,
              },
            ],
            nextUrl,
          ),
        )
        .mockResolvedValueOnce(
          pageResponse(
            [
              {
                id: 2,
                name: 'job-b',
                stage: 'test',
                status: 'failed',
                started_at: '2026-04-11T10:02:00Z',
                finished_at: '2026-04-11T10:03:00Z',
                duration: 60,
                web_url: 'https://gitlab.example.com/group/proj/-/jobs/2',
                failure_reason: 'script_failure',
              },
            ],
            null,
          ),
        );

      const result = await gateway.getJobs(42, 5501, { includeRetried: false });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // 2ページ目はLinkヘッダのURLを使用
      expect(mockFetch).toHaveBeenNthCalledWith(2, nextUrl, {
        headers: { 'PRIVATE-TOKEN': 'test-token' },
      });
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[0].failureReason).toBeNull();
      expect(result[1].id).toBe(2);
      expect(result[1].failureReason).toBe('script_failure');
    });

    it('artifacts_file が未設定のジョブは hasArtifacts=false, artifactsSize=0 になる', async () => {
      const jobs = [
        {
          id: 2001,
          name: 'lint',
          stage: 'test',
          status: 'success',
          started_at: '2026-04-11T10:00:00Z',
          finished_at: '2026-04-11T10:02:00Z',
          duration: 120,
          web_url: 'https://gitlab.example.com/group/proj/-/jobs/2001',
          failure_reason: null,
          // artifacts_file なし
        },
        {
          id: 2002,
          name: 'test',
          stage: 'test',
          status: 'success',
          started_at: null,
          finished_at: null,
          duration: null,
          web_url: 'https://gitlab.example.com/group/proj/-/jobs/2002',
          failure_reason: null,
          artifacts_file: { size: 4096 },
        },
      ];
      mockFetch.mockResolvedValueOnce(pageResponse(jobs, null));

      const result = await gateway.getJobs(42, 5501, { includeRetried: false });

      expect(result[0].hasArtifacts).toBe(false);
      expect(result[0].artifactsSize).toBe(0);
      expect(result[0].startedAt).not.toBeNull();
      expect(result[1].hasArtifacts).toBe(true);
      expect(result[1].artifactsSize).toBe(4096);
      // null のタイムスタンプ系フィールドは null で保持
      expect(result[1].startedAt).toBeNull();
      expect(result[1].finishedAt).toBeNull();
      expect(result[1].duration).toBeNull();
    });

    it('includeRetried=true の場合、クエリパラメータを include_retried=true で送信する', async () => {
      mockFetch.mockResolvedValueOnce(pageResponse([], null));

      await gateway.getJobs(42, 5501, { includeRetried: true });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/pipelines/5501/jobs?include_retried=true&per_page=100',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
    });

    it('HTTPエラーの場合、エラーを伝播する', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
      });

      await expect(gateway.getJobs(42, 5501, { includeRetried: false })).rejects.toThrow(
        'GitLab API error: 500 Internal Server Error',
      );
    });
  });

  describe('getJobTrace', () => {
    it('ジョブのトレーステキストを取得する', async () => {
      const traceText = 'Running job-a...\nStep 1 passed\nStep 2 passed\n';
      mockFetch.mockResolvedValueOnce(textResponse(traceText));

      const result = await gateway.getJobTrace(42, 1001);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/jobs/1001/trace',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
      expect(result).toBe(traceText);
    });

    it('404 の場合、エラーを throw する', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

      await expect(gateway.getJobTrace(42, 9999)).rejects.toThrow(
        'GitLab API error: 404 Not Found',
      );
    });
  });

  describe('getMergedYaml', () => {
    it('CI Lint API から merged_yaml を取得して返す', async () => {
      const lintResponse = {
        valid: true,
        merged_yaml: 'stages:\n  - build\n  - test\njob1:\n  script: echo hello\n',
        errors: [],
        warnings: [],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(lintResponse));

      const result = await gateway.getMergedYaml(42, 'main');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/ci/lint?content_ref=main',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
      expect(result).toBe(lintResponse.merged_yaml);
    });

    it('HTTP エラーの場合、null を返す（エラーを throw しない）', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

      const result = await gateway.getMergedYaml(42, 'main');

      expect(result).toBeNull();
    });

    it('ネットワークエラーの場合、null を返す', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await gateway.getMergedYaml(42, 'main');

      expect(result).toBeNull();
    });

    it('ref に特殊文字を含む場合、URL エンコードされる', async () => {
      const lintResponse = {
        valid: true,
        merged_yaml: 'stages:\n  - build\n',
        errors: [],
        warnings: [],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(lintResponse));

      await gateway.getMergedYaml(42, 'feature/my-branch');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/ci/lint?content_ref=feature%2Fmy-branch',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
    });
  });

  describe('downloadArtifactArchive', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-artifact-test-'));
    });

    afterEach(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('maxBytes 未満のアーカイブは全バイト書き込まれ truncated=false を返す', async () => {
      const chunk1 = new Uint8Array([1, 2, 3, 4]);
      const chunk2 = new Uint8Array([5, 6, 7, 8, 9, 10]);
      mockFetch.mockResolvedValueOnce(streamResponse([chunk1, chunk2]));

      const destPath = path.join(tmpDir, 'artifact.zip');
      const result = await gateway.downloadArtifactArchive(42, 1001, destPath, { maxBytes: 1000 });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://gitlab.example.com/api/v4/projects/42/jobs/1001/artifacts',
        { headers: { 'PRIVATE-TOKEN': 'test-token' } },
      );
      expect(result.bytesWritten).toBe(10);
      expect(result.truncated).toBe(false);
      const written = await fsp.readFile(destPath);
      expect(Array.from(written)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('maxBytes を超える場合は先頭のみ書き込み truncated=true を返す', async () => {
      const chunk1 = new Uint8Array([10, 20, 30, 40, 50]);
      const chunk2 = new Uint8Array([60, 70, 80, 90, 100]);
      const chunk3 = new Uint8Array([110, 120, 130]);
      mockFetch.mockResolvedValueOnce(streamResponse([chunk1, chunk2, chunk3]));

      const destPath = path.join(tmpDir, 'truncated.zip');
      const result = await gateway.downloadArtifactArchive(42, 1001, destPath, { maxBytes: 7 });

      expect(result.bytesWritten).toBe(7);
      expect(result.truncated).toBe(true);
      const written = await fsp.readFile(destPath);
      // 先頭 7 バイトのみ書き込まれる
      expect(Array.from(written)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    });

    it('書き込み失敗時は write stream を閉じてエラーを throw する', async () => {
      const chunk = new Uint8Array([1, 2, 3]);
      mockFetch.mockResolvedValueOnce(streamResponse([chunk]));

      // 存在しないディレクトリ配下に書き込みを試みて失敗させる
      const destPath = path.join(tmpDir, 'no-such-dir', 'out.zip');

      await expect(
        gateway.downloadArtifactArchive(42, 1001, destPath, { maxBytes: 1000 }),
      ).rejects.toThrow();
    });

    it('HTTPエラーの場合、ファイルは作成されずエラーを throw する', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

      const destPath = path.join(tmpDir, 'forbidden.zip');
      await expect(
        gateway.downloadArtifactArchive(42, 1001, destPath, { maxBytes: 1000 }),
      ).rejects.toThrow('GitLab API error: 403 Forbidden');
      expect(fs.existsSync(destPath)).toBe(false);
    });

    it('maxBytes が 0 の場合、呼び出し側のバグ検出のためエラーを throw する', async () => {
      const destPath = path.join(tmpDir, 'zero.zip');

      // 事前ガードで弾かれるため fetch は呼ばれない想定
      await expect(
        gateway.downloadArtifactArchive(42, 1001, destPath, { maxBytes: 0 }),
      ).rejects.toThrow('maxBytes must be positive');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fs.existsSync(destPath)).toBe(false);
    });

    it('maxBytes が負の場合、エラーを throw する', async () => {
      const destPath = path.join(tmpDir, 'negative.zip');

      await expect(
        gateway.downloadArtifactArchive(42, 1001, destPath, { maxBytes: -1 }),
      ).rejects.toThrow('maxBytes must be positive');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fs.existsSync(destPath)).toBe(false);
    });

    it('response.body が null の場合、エラーを throw する', async () => {
      // fetch のレスポンスから body ストリームが得られないケース
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: null,
        headers: { get: () => null },
      });

      const destPath = path.join(tmpDir, 'no-body.zip');
      await expect(
        gateway.downloadArtifactArchive(42, 1001, destPath, { maxBytes: 1000 }),
      ).rejects.toThrow('GitLab artifacts response did not include a body stream');
    });
  });
});
