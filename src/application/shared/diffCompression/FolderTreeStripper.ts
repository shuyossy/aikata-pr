/**
 * フォルダツリーからファイルエントリを除去し、ディレクトリ構造のみ残す
 *
 * ツリーフォーマット:
 * - ディレクトリ: 末尾に`/`（例: `src/`）
 * - ファイル: 末尾にスラッシュなし（例: `index.ts`）
 * - truncatedメッセージ: `...`で始まる行は保持
 */
export function stripFilesFromFolderTree(folderTree: string): string {
  if (!folderTree) return '';

  const lines = folderTree.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    // ディレクトリ（末尾が/）またはtruncatedメッセージは保持
    if (trimmed.endsWith('/') || trimmed.startsWith('...')) {
      result.push(line);
    }
  }

  return result.join('\n');
}
