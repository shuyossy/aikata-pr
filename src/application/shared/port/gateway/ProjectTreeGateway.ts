/**
 * フォルダツリー取得時のオプション
 */
export interface ProjectTreeOptions {
  /** 走査の最大深度。undefinedの場合は無制限 */
  maxDepth: number | undefined;
}

/**
 * プロジェクトのフォルダツリーを取得するためのゲートウェイインターフェース
 */
export interface ProjectTreeGateway {
  getTree(projectDir: string, options: ProjectTreeOptions): Promise<string>;
}
