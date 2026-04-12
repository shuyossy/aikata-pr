import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { getArtifactContentTool } from '../getArtifactContent.js';
import type { ArtifactArchiveReader } from '../../../../application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.js';
import type { PendingImageData } from '../../../shared/readImageCommon.js';

type GetArtifactContentResult =
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'image'; mimeType: string; message: string }
  | { kind: 'unsupported'; mimeType: string; size: number; reason: string }
  | { kind: 'error'; reason: string };

/**
 * テスト用のfake ArtifactArchiveReader
 * readFileで固定データを返すスタブ。throwOnReadでエラー注入も可能。
 */
class FakeArchiveReader implements ArtifactArchiveReader {
  constructor(
    private readonly entries: Map<string, { data: Buffer; truncated: boolean }>,
    private readonly throwOnRead = false,
  ) {}

  async listEntries(): Promise<[]> {
    return [];
  }

  async readFile(
    _zipPath: string,
    innerPath: string,
  ): Promise<{ data: Buffer; truncated: boolean }> {
    if (this.throwOnRead) {
      throw new Error('injected failure');
    }
    const found = this.entries.get(innerPath);
    if (!found) {
      throw new Error(`artifact entry not found: ${innerPath}`);
    }
    return found;
  }
}

/**
 * getArtifactContentToolのexecuteを呼び出すヘルパー
 */
const executeGetArtifactContent = (
  input: { jobId: number; artifactPath: string },
  options: {
    artifactCachePaths: Map<number, string | null>;
    archiveReader: ArtifactArchiveReader;
    pendingImages?: PendingImageData[];
  },
): Promise<{
  result: GetArtifactContentResult;
  pendingImages: PendingImageData[];
}> => {
  const executeFn = getArtifactContentTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const pendingImages: PendingImageData[] = options.pendingImages ?? [];
  const requestContext = new RequestContext([
    ['artifactCachePaths', options.artifactCachePaths],
    ['artifactArchiveReader', options.archiveReader],
    ['pendingImages', pendingImages],
  ]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof getArtifactContentTool.execute>>[1];
  return (executeFn(input, context) as Promise<GetArtifactContentResult>).then((result) => ({
    result,
    pendingImages,
  }));
};

describe('getArtifactContentTool', () => {
  it('テキストファイルを正常に返す（truncated=false）', async () => {
    const entries = new Map([
      ['build.log', { data: Buffer.from('hello build log\n', 'utf-8'), truncated: false }],
    ]);
    const { result } = await executeGetArtifactContent(
      { jobId: 10, artifactPath: 'build.log' },
      {
        artifactCachePaths: new Map([[10, '/tmp/artifact.zip']]),
        archiveReader: new FakeArchiveReader(entries),
      },
    );

    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.content).toBe('hello build log\n');
      expect(result.truncated).toBe(false);
    }
  });

  it('テキストファイルを返す（truncated=true）', async () => {
    const entries = new Map([
      ['build.log', { data: Buffer.from('partial text', 'utf-8'), truncated: true }],
    ]);
    const { result } = await executeGetArtifactContent(
      { jobId: 10, artifactPath: 'build.log' },
      {
        artifactCachePaths: new Map([[10, '/tmp/artifact.zip']]),
        archiveReader: new FakeArchiveReader(entries),
      },
    );

    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.content).toBe('partial text');
      expect(result.truncated).toBe(true);
    }
  });

  it('PNG画像はpendingImagesに積まれ kind=imageを返す', async () => {
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const entries = new Map([['screenshot.png', { data: pngData, truncated: false }]]);

    const { result, pendingImages } = await executeGetArtifactContent(
      { jobId: 20, artifactPath: 'screenshot.png' },
      {
        artifactCachePaths: new Map([[20, '/tmp/artifact.zip']]),
        archiveReader: new FakeArchiveReader(entries),
      },
    );

    expect(result.kind).toBe('image');
    if (result.kind === 'image') {
      expect(result.mimeType).toBe('image/png');
      expect(result.message).toContain('screenshot.png');
      expect(result.message).toContain('next user message');
    }
    expect(pendingImages.length).toBe(1);
    const entry = pendingImages.find((e) => e.filePath === '20:screenshot.png');
    expect(entry).toBeDefined();
    expect(entry!.mediaType).toBe('image/png');
    expect(entry!.base64Data).toBe(pngData.toString('base64'));
  });

  it('バイナリ（非画像）は kind=unsupportedを返す', async () => {
    // ELFマジックバイト: 7F 45 4C 46
    const binData = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0xff, 0xfe]);
    const entries = new Map([['a.out', { data: binData, truncated: false }]]);

    const { result, pendingImages } = await executeGetArtifactContent(
      { jobId: 30, artifactPath: 'a.out' },
      {
        artifactCachePaths: new Map([[30, '/tmp/artifact.zip']]),
        archiveReader: new FakeArchiveReader(entries),
      },
    );

    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') {
      expect(result.size).toBe(binData.length);
      expect(result.reason).toMatch(/binary/i);
    }
    expect(pendingImages.length).toBe(0);
  });

  it('zipPathがnullの場合 kind=errorを返す', async () => {
    const entries = new Map<string, { data: Buffer; truncated: boolean }>();
    const { result } = await executeGetArtifactContent(
      { jobId: 40, artifactPath: 'anything.txt' },
      {
        artifactCachePaths: new Map([[40, null]]),
        archiveReader: new FakeArchiveReader(entries),
      },
    );

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toMatch(/artifact/i);
    }
  });

  it('ファイル拡張子が.pngだが中身がテキストの場合はtextとして扱う', async () => {
    // 拡張子は画像だがマジックバイトは画像ではない（UTF-8のテキスト）
    const fakeData = Buffer.from('not a real png', 'utf-8');
    const entries = new Map([['foo.png', { data: fakeData, truncated: false }]]);

    const { result, pendingImages } = await executeGetArtifactContent(
      { jobId: 60, artifactPath: 'foo.png' },
      {
        artifactCachePaths: new Map([[60, '/tmp/artifact.zip']]),
        archiveReader: new FakeArchiveReader(entries),
      },
    );

    // UTF-8としてデコードできるのでtextになる、バイナリならunsupportedになる
    expect(['text', 'unsupported']).toContain(result.kind);
    // 画像としては扱われないのでpendingImagesは空のままであること
    expect(pendingImages.length).toBe(0);
    if (result.kind === 'text') {
      expect(result.content).toBe('not a real png');
    }
  });

  it('archiveReaderが例外を投げた場合 kind=errorを返す', async () => {
    const entries = new Map<string, { data: Buffer; truncated: boolean }>();
    const { result } = await executeGetArtifactContent(
      { jobId: 50, artifactPath: 'any.txt' },
      {
        artifactCachePaths: new Map([[50, '/tmp/artifact.zip']]),
        archiveReader: new FakeArchiveReader(entries, true),
      },
    );

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toMatch(/injected failure/);
    }
  });
});
