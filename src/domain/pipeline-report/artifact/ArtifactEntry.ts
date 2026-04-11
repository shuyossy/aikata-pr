/**
 * GitLab job artifacts の単一エントリ（ファイルまたはディレクトリ）
 */
export interface ArtifactEntry {
  path: string;
  type: 'file' | 'tree';
  size: number;
  mode: string;
}
