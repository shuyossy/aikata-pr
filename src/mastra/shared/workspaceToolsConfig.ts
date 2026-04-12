import type { WorkspaceToolsConfig } from '@mastra/core/workspace';

/**
 * workspace toolの出力トークン���限設定
 *
 * Mastraデフォルト値（read_file=2000, grep=2000, list_files=1000, execute_command=2000）
 * を本アプリのユースケースに合わせて最適化する。
 *
 * 設計根拠:
 * - read_file (4000): コードレビュー時、中規模ファイル（200-300行）をページネーション不要で閲覧可能にする
 * - grep (3000): 検索結果をより多く取得し、コードパターンの把握効率を向上させる
 * - list_files (2000): プロジェクト構造の把握に十分なツリー出力を確保する
 * - execute_command (4000): ビルドログ・テスト結果の解析に十分���出力を確保する
 *
 * 詳細は docs/archtecture/workspace-tool-investigation.md を参照
 */
export const WORKSPACE_TOOLS_CONFIG: WorkspaceToolsConfig = {
  mastra_workspace_read_file: { maxOutputTokens: 4000 },
  mastra_workspace_grep: { maxOutputTokens: 3000 },
  mastra_workspace_list_files: { maxOutputTokens: 2000 },
  mastra_workspace_execute_command: { maxOutputTokens: 4000 },
};
