/**
 * 複数のdiff文字列をファイルパス付きのgit diff形式で結合する
 */
export function combineDiffs(
  diffs: Array<{ oldPath: string; newPath: string; diff: string }>,
): string {
  if (diffs.length === 0) {
    return '';
  }
  return diffs
    .map(({ oldPath, newPath, diff }) => {
      const header = `diff --git a/${oldPath} b/${newPath}`;
      // diff内容が既に --- a/ ヘッダーを含む場合はそのまま結合
      if (diff.startsWith('--- a/')) {
        return `${header}\n${diff}`;
      }
      // --- a/ ヘッダーがない場合は追加
      return `${header}\n--- a/${oldPath}\n+++ b/${newPath}\n${diff}`;
    })
    .join('\n');
}
