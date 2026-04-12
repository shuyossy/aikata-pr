import { createWriteStream, type WriteStream } from 'node:fs';
import {
  Pipeline,
  type PipelineStatus,
} from '../../../../domain/pipeline-report/pipeline/Pipeline.js';
import { Job } from '../../../../domain/pipeline-report/job/Job.js';
import type { JobStatus } from '../../../../domain/pipeline-report/job/JobStatus.js';
import type { PipelineGateway } from '../../../../application/shared/port/gateway/PipelineGateway.js';
import { GitLabApiClient } from '../../httpClient/GitLabApiClient.js';

/**
 * GitLab API から返却されるパイプラインレスポンスの型定義
 */
interface GitLabPipelineResponse {
  id: number;
  project_id: number;
  sha: string;
  ref: string;
  status: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

/**
 * GitLab API から返却されるジョブレスポンスの型定義
 */
interface GitLabJobResponse {
  id: number;
  name: string;
  stage: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  web_url: string;
  failure_reason: string | null;
  artifacts_file?: { size: number; filename?: string };
}

/**
 * GitLab CI Lint API から返却されるレスポンスの型定義
 */
interface GitLabCiLintResponse {
  valid: boolean;
  merged_yaml: string;
  errors: string[];
  warnings: string[];
}

/**
 * GitLab API を利用した PipelineGateway の実装
 * パイプライン・ジョブ・トレース・アーティファクトアーカイブを取得する。
 */
export class GitLabPipelineGateway implements PipelineGateway {
  private readonly client: GitLabApiClient;

  constructor(client: GitLabApiClient) {
    this.client = client;
  }

  /**
   * パイプラインのメタ情報を取得し Pipeline entity に変換する。
   */
  async getPipeline(projectId: number, pipelineId: number): Promise<Pipeline> {
    const response = await this.client.get<GitLabPipelineResponse>(
      `/projects/${projectId}/pipelines/${pipelineId}`,
    );
    return Pipeline.of({
      projectId: response.project_id,
      pipelineId: response.id,
      ref: response.ref,
      sha: response.sha,
      status: response.status as PipelineStatus,
      webUrl: response.web_url,
      createdAt: new Date(response.created_at),
      updatedAt: new Date(response.updated_at),
    });
  }

  /**
   * パイプライン配下のジョブ一覧をページネーション全取得し Job entity の配列に変換する。
   */
  async getJobs(
    projectId: number,
    pipelineId: number,
    options: { includeRetried: boolean },
  ): Promise<Job[]> {
    // include_retried を明示することで意図しない古いジョブ混入を防ぐ
    const includeRetried = options.includeRetried ? 'true' : 'false';
    const responses = await this.client.getAll<GitLabJobResponse>(
      `/projects/${projectId}/pipelines/${pipelineId}/jobs?include_retried=${includeRetried}`,
    );
    return responses.map((job) => this.toJobEntity(job));
  }

  /**
   * プロジェクトの CI/CD 設定（includes 展開済み merged YAML）を取得する。
   * 取得失敗時は null を返し、呼び出し元が graceful degradation できるようにする。
   */
  async getMergedYaml(projectId: number, ref: string): Promise<string | null> {
    try {
      const response = await this.client.get<GitLabCiLintResponse>(
        `/projects/${projectId}/ci/lint?content_ref=${encodeURIComponent(ref)}`,
      );
      return response.merged_yaml;
    } catch {
      return null;
    }
  }

  /**
   * ジョブのトレース（標準出力・標準エラー）を取得する。
   */
  async getJobTrace(projectId: number, jobId: number): Promise<string> {
    return this.client.getText(`/projects/${projectId}/jobs/${jobId}/trace`);
  }

  /**
   * ジョブのアーティファクト zip を destPath にダウンロードする。
   * レスポンスボディを読みつつ `maxBytes` を超えたら早期停止し truncated=true を返す。
   */
  async downloadArtifactArchive(
    projectId: number,
    jobId: number,
    destPath: string,
    options: { maxBytes: number },
  ): Promise<{ bytesWritten: number; truncated: boolean }> {
    // 呼び出し側のバグを早期検出するための事前ガード
    // （0 以下だと空ファイルを作って即 truncate することになり意図が不明瞭なため弾く）
    if (options.maxBytes <= 0) {
      throw new Error('maxBytes must be positive');
    }

    const response = await this.client.getResponse(
      `/projects/${projectId}/jobs/${jobId}/artifacts`,
    );
    const body = response.body;
    if (!body) {
      throw new Error('GitLab artifacts response did not include a body stream');
    }

    const writer: WriteStream = createWriteStream(destPath);
    // 書き込みエラー伝播用 Promise
    const writeErrorPromise = new Promise<never>((_, reject) => {
      writer.once('error', (err) => reject(err));
    });

    const reader = body.getReader();
    let bytesWritten = 0;
    let truncated = false;

    /**
     * WriteStream に 1 チャンクを書き込み、drain を待機する
     */
    const writeChunk = async (chunk: Uint8Array): Promise<void> => {
      if (!writer.write(chunk)) {
        await new Promise<void>((resolve) => writer.once('drain', () => resolve()));
      }
    };

    try {
      // 書き込み処理とエラー監視を同時に待つ
      await Promise.race([
        (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              return;
            }
            if (!value) {
              continue;
            }
            const remaining = options.maxBytes - bytesWritten;
            if (remaining <= 0) {
              truncated = true;
              // 上限到達済みのため以降のチャンクは破棄
              await reader.cancel();
              return;
            }
            if (value.byteLength <= remaining) {
              await writeChunk(value);
              bytesWritten += value.byteLength;
            } else {
              // 残容量ぶんだけ切り取って書き込み、以降は打ち切る
              const slice = value.subarray(0, remaining);
              await writeChunk(slice);
              bytesWritten += slice.byteLength;
              truncated = true;
              await reader.cancel();
              return;
            }
          }
        })(),
        writeErrorPromise,
      ]);
    } catch (err) {
      // エラー時はストリームを破棄して write stream を閉じる
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        writer.once('close', () => resolve());
        writer.destroy();
      });
      throw err;
    }

    // 正常終了時は write stream を確実に閉じる
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    return { bytesWritten, truncated };
  }

  /**
   * GitLab API のジョブレスポンスを Job entity に変換する。
   */
  private toJobEntity(job: GitLabJobResponse): Job {
    const artifactsFile = job.artifacts_file ?? null;
    const hasArtifacts = artifactsFile !== null;
    const artifactsSize = artifactsFile?.size ?? 0;
    return Job.of({
      id: job.id,
      name: job.name,
      stage: job.stage,
      status: job.status as JobStatus,
      startedAt: job.started_at ? new Date(job.started_at) : null,
      finishedAt: job.finished_at ? new Date(job.finished_at) : null,
      duration: job.duration,
      webUrl: job.web_url,
      failureReason: job.failure_reason,
      hasArtifacts,
      artifactsSize,
    });
  }
}
