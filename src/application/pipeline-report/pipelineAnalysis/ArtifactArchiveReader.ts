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
        // zipfile.close()漏れを防ぐための終端ハンドラ。成功/失敗どちらでも必ずcloseする。
        let settled = false;
        const finalize = (action: () => void): void => {
          if (settled) return;
          settled = true;
          try {
            zipfile.close();
          } catch {
            // closeの二重呼び出しや内部状態エラーは無視する
          }
          action();
        };
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
        zipfile.on('end', () => finalize(() => resolvePromise(results)));
        zipfile.on('error', (zipErr: Error) => finalize(() => rejectPromise(zipErr)));
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
        // zipfile.close()漏れ + resolve/reject二重呼び出しを防ぐための終端ハンドラ。
        let settled = false;
        const finalize = (action: () => void): void => {
          if (settled) return;
          settled = true;
          try {
            zipfile.close();
          } catch {
            // closeの二重呼び出しや内部状態エラーは無視する
          }
          action();
        };
        let found = false;
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (entry.fileName !== innerPath) {
            zipfile.readEntry();
            return;
          }
          found = true;
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              finalize(() => rejectPromise(streamErr ?? new Error('read stream is null')));
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            let truncated = false;
            // maxBytes到達時にストリームをdestroy()してI/O・解凍コストを中断する。
            // destroyed=true以降のdata/errorイベントは無視し、end/closeで一度だけfinalizeする。
            let destroyed = false;
            stream.on('data', (chunk: Buffer) => {
              if (destroyed) return;
              if (total >= options.maxBytes) {
                truncated = true;
                destroyed = true;
                stream.destroy();
                return;
              }
              const remaining = options.maxBytes - total;
              if (chunk.length > remaining) {
                chunks.push(chunk.subarray(0, remaining));
                total += remaining;
                truncated = true;
                destroyed = true;
                stream.destroy();
              } else {
                chunks.push(chunk);
                total += chunk.length;
              }
            });
            stream.on('end', () => {
              finalize(() => resolvePromise({ data: Buffer.concat(chunks), truncated }));
            });
            stream.on('close', () => {
              if (destroyed) {
                finalize(() => resolvePromise({ data: Buffer.concat(chunks), truncated }));
              }
            });
            stream.on('error', (streamEndErr: Error) => {
              if (destroyed) {
                // destroy()に伴う擬似エラーは無視（close/endハンドラ側で解決済み）
                return;
              }
              finalize(() => rejectPromise(streamEndErr));
            });
          });
        });
        zipfile.on('end', () => {
          if (!found) {
            finalize(() => rejectPromise(new Error(`artifact entry not found: ${innerPath}`)));
          }
        });
        zipfile.on('error', (zipErr: Error) => finalize(() => rejectPromise(zipErr)));
        zipfile.readEntry();
      });
    });
  }
}
