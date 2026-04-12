/**
 * リポジトリクローンの結果を表すインターフェース
 */
export interface CloneResult {
  /** クローンされたリポジトリのルートディレクトリパス */
  projectDir: string;
  /** ソースブランチ名 */
  sourceBranch: string;
  /** ターゲットブランチ名 */
  targetBranch: string;
  /** クリーンアップ関数（一時ディレクトリを削除） */
  cleanup: () => Promise<void>;
}

/**
 * リポジトリのクローン管理を行うポートインターフェース
 * APIリクエストごとにリポジトリをクローンし、処理後にクリーンアップする
 */
export interface CloneManagerPort {
  /**
   * リポジトリをクローンし、MR関連ブランチを取得する
   */
  clone(
    gitlabToken: string,
    gitlabApiBaseUrl: string,
    projectId: string,
    sourceBranch: string,
    targetBranch: string,
    commitSha: string | null,
  ): Promise<CloneResult>;
}
