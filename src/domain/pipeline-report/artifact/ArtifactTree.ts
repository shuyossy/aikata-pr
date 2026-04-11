import type { ArtifactEntry } from './ArtifactEntry.js';

/**
 * ジョブ単位の artifacts ツリーを表現する値オブジェクト。
 * ファイル・ディレクトリのエントリ一覧を保持する。
 */
export class ArtifactTree {
  private constructor(
    readonly jobId: number,
    readonly jobName: string,
    readonly entries: readonly ArtifactEntry[],
  ) {}

  /**
   * 指定ジョブの artifacts ツリーを生成する。
   * entries は防御的コピーして内部に保持する。
   */
  static of(params: {
    jobId: number;
    jobName: string;
    entries: readonly ArtifactEntry[];
  }): ArtifactTree {
    return new ArtifactTree(params.jobId, params.jobName, [...params.entries]);
  }

  /**
   * artifacts を持たないジョブ用の空ツリーを生成する。
   */
  static empty(jobId: number, jobName: string): ArtifactTree {
    return new ArtifactTree(jobId, jobName, []);
  }

  /**
   * ファイル（type === 'file'）のパスのみを返す。
   */
  filePaths(): string[] {
    return this.entries.filter((e) => e.type === 'file').map((e) => e.path);
  }
}
