/**
 * GitLab job artifacts の単一エントリ（ファイルまたはディレクトリ）
 */
export interface ArtifactEntry {
  readonly path: string;
  readonly type: 'file' | 'tree';
  readonly size: number;
  readonly mode: string;
}
