import yauzl from 'yauzl';
import type { ArtifactEntry } from '../../../domain/pipeline-report/artifact/ArtifactEntry.js';

/**
 * アーティファクトzipアーカイブの読み取りポート。
 * 実装はyauzlベース（pure JS）。
 */
export interface ArtifactArchiveReader {
  /**
   * 指定zipファイル内のエントリ一覧を返す。
   */
  listEntries(zipPath: string): Promise<ArtifactEntry[]>;

  /**
   * 指定zipファイル内の特定エントリを読み取る。
   * maxBytesを超えた分は切り捨てられ、truncated=trueで返す。
   */
  readFile(
    zipPath: string,
    innerPath: string,
    options: { maxBytes: number },
  ): Promise<{ data: Buffer; truncated: boolean }>;
}

/**
 * yauzlを利用したArtifactArchiveReader実装
 */
export class YauzlArtifactArchiveReader implements ArtifactArchiveReader {
  async listEntries(zipPath: string): Promise<ArtifactEntry[]> {
    return new Promise<ArtifactEntry[]>((resolvePromise, rejectPromise) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          rejectPromise(err);
          return;
        }
        if (!zipfile) {
          rejectPromise(new Error('zipfile is null'));
          return;
        }
        const results: ArtifactEntry[] = [];
        zipfile.on('entry', (entry: yauzl.Entry) => {
          // ディレクトリエントリは末尾が '/' で判別
          const isDir = /\/$/.test(entry.fileName);
          results.push({
            path: entry.fileName,
            type: isDir ? 'tree' : 'file',
            size: entry.uncompressedSize,
            mode: (entry.externalFileAttributes >>> 16).toString(8).padStart(6, '0'),
          });
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolvePromise(results));
        zipfile.on('error', rejectPromise);
        zipfile.readEntry();
      });
    });
  }

  async readFile(
    zipPath: string,
    innerPath: string,
    options: { maxBytes: number },
  ): Promise<{ data: Buffer; truncated: boolean }> {
    return new Promise<{ data: Buffer; truncated: boolean }>((resolvePromise, rejectPromise) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          rejectPromise(err);
          return;
        }
        if (!zipfile) {
          rejectPromise(new Error('zipfile is null'));
          return;
        }
        let found = false;
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (entry.fileName !== innerPath) {
            zipfile.readEntry();
            return;
          }
          found = true;
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              zipfile.close();
              rejectPromise(streamErr ?? new Error('read stream is null'));
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            let truncated = false;
            stream.on('data', (chunk: Buffer) => {
              if (total >= options.maxBytes) {
                truncated = true;
                return;
              }
              const remaining = options.maxBytes - total;
              if (chunk.length > remaining) {
                chunks.push(chunk.subarray(0, remaining));
                total += remaining;
                truncated = true;
              } else {
                chunks.push(chunk);
                total += chunk.length;
              }
            });
            stream.on('end', () => {
              zipfile.close();
              resolvePromise({ data: Buffer.concat(chunks), truncated });
            });
            stream.on('error', (streamEndErr: Error) => {
              zipfile.close();
              rejectPromise(streamEndErr);
            });
          });
        });
        zipfile.on('end', () => {
          if (!found) {
            rejectPromise(new Error(`artifact entry not found: ${innerPath}`));
          }
        });
        zipfile.on('error', rejectPromise);
        zipfile.readEntry();
      });
    });
  }
}
