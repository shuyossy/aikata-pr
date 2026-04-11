import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YauzlArtifactArchiveReader } from '../ArtifactArchiveReader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// pre-builtのzipフィクスチャを使用する
const FIXTURE_ZIP = resolve(__dirname, 'fixtures/artifacts/sample.zip');

describe('YauzlArtifactArchiveReader', () => {
  it('zip内の全エントリをリストできる', async () => {
    const reader = new YauzlArtifactArchiveReader();
    const entries = await reader.listEntries(FIXTURE_ZIP);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['content-a.txt', 'content-b.txt', 'large.bin']);
    const a = entries.find((e) => e.path === 'content-a.txt');
    expect(a?.type).toBe('file');
    expect(a?.size).toBe(11);
    const large = entries.find((e) => e.path === 'large.bin');
    expect(large?.type).toBe('file');
    expect(large?.size).toBe(64 * 1024);
  });

  it('内部パスを指定してファイルを読み取れる', async () => {
    const reader = new YauzlArtifactArchiveReader();
    const result = await reader.readFile(FIXTURE_ZIP, 'content-a.txt', {
      maxBytes: 1024,
    });
    expect(result.data.toString('utf8')).toBe('hello world');
    expect(result.truncated).toBe(false);
  });

  it('maxBytesを超えると切り捨てフラグが立つ', async () => {
    const reader = new YauzlArtifactArchiveReader();
    const result = await reader.readFile(FIXTURE_ZIP, 'content-a.txt', {
      maxBytes: 5,
    });
    expect(result.data.length).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.data.toString('utf8')).toBe('hello');
  });

  it('大容量エントリをmaxBytes=100で読むと100バイトで切り捨てられる', async () => {
    const reader = new YauzlArtifactArchiveReader();
    // ストリーム halt が機能しないと大容量エントリの全バイトを処理してしまう。
    // 短いタイムアウトで完了することで halt が機能していることを間接的に確認する。
    const result = await Promise.race([
      reader.readFile(FIXTURE_ZIP, 'large.bin', { maxBytes: 100 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('readFile timed out')), 5000),
      ),
    ]);
    expect(result.data.length).toBe(100);
    expect(result.truncated).toBe(true);
    // 固定パターン(i % 256)の先頭100バイトであること
    for (let i = 0; i < 100; i += 1) {
      expect(result.data[i]).toBe(i % 256);
    }
  });

  it('存在しないエントリを読むとエラーになる', async () => {
    const reader = new YauzlArtifactArchiveReader();
    await expect(
      reader.readFile(FIXTURE_ZIP, 'nonexistent.txt', { maxBytes: 1024 }),
    ).rejects.toThrow();
  });
});
