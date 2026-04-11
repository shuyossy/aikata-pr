/**
 * MRコンテキスト値オブジェクト
 * MRのメタデータ（タイトル、説明、ブランチ、差分、コミットハッシュ）を保持する
 */
interface MrContextParams {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  diff: string;
  commitHash: string;
  commitMessage: string;
}

export class MrContext {
  readonly title: string;
  readonly description: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly diff: string;
  readonly commitHash: string;
  readonly commitMessage: string;

  constructor(params: MrContextParams) {
    this.title = params.title;
    this.description = params.description;
    this.sourceBranch = params.sourceBranch;
    this.targetBranch = params.targetBranch;
    this.diff = params.diff;
    this.commitHash = params.commitHash;
    this.commitMessage = params.commitMessage;
  }
}
