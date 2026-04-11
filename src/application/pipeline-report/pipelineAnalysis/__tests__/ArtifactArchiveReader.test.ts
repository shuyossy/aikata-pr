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
    expect(paths).toEqual(['content-a.txt', 'content-b.txt']);
    const a = entries.find((e) => e.path === 'content-a.txt');
    expect(a?.type).toBe('file');
    expect(a?.size).toBe(11);
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

  it('存在しないエントリを読むとエラーになる', async () => {
    const reader = new YauzlArtifactArchiveReader();
    await expect(
      reader.readFile(FIXTURE_ZIP, 'nonexistent.txt', { maxBytes: 1024 }),
    ).rejects.toThrow();
  });
});
