import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { readImageTool, READ_IMAGE_TOOL_KEY, PENDING_IMAGES_KEY } from '../readImage.js';
import type { PendingImageData } from '../readImage.js';

/**
 * readImageToolのexecuteを型安全に呼び出すヘルパー
 * RequestContextを返すことでpendingImagesの検証を可能にする
 */
const executeReadImage = (
  input: { filePath: string },
  projectDir: string,
): Promise<{
  result: {
    success: boolean;
    filePath: string;
    mediaType?: string;
    message?: string;
  };
  requestContext: RequestContext;
}> => {
  const executeFn = readImageTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext: RequestContext = new RequestContext([['projectDir', projectDir]]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof readImageTool.execute>>[1];
  return (
    executeFn(input, context) as Promise<{
      success: boolean;
      filePath: string;
      mediaType?: string;
      message?: string;
    }>
  ).then((result) => ({ result, requestContext }));
};

describe('readImageTool', () => {
  let tmpDir: string;

  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-image-'));
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('READ_IMAGE_TOOL_KEYが "readImage" である', () => {
    expect(READ_IMAGE_TOOL_KEY).toBe('readImage');
  });

  it('toModelOutputが定義されていない', () => {
    expect(readImageTool.toModelOutput).toBeUndefined();
  });

  describe('execute', () => {
    it('PNGファイルを正しく読み取れる', async () => {
      createTmpDir();
      const pngData = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      );
      fs.writeFileSync(path.join(tmpDir, 'test.png'), pngData);

      const { result } = await executeReadImage({ filePath: 'test.png' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('test.png');
      expect(result.mediaType).toBe('image/png');
      // base64Dataは返り値に含まれない
      expect(result).not.toHaveProperty('base64Data');
    });

    it('JPGファイルを正しく読み取れる', async () => {
      createTmpDir();
      const jpgData = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      fs.writeFileSync(path.join(tmpDir, 'test.jpg'), jpgData);

      const { result } = await executeReadImage({ filePath: 'test.jpg' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result.mediaType).toBe('image/jpeg');
    });

    it('JPEGファイルを正しく読み取れる', async () => {
      createTmpDir();
      const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      fs.writeFileSync(path.join(tmpDir, 'test.jpeg'), jpegData);

      const { result } = await executeReadImage({ filePath: 'test.jpeg' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result.mediaType).toBe('image/jpeg');
    });

    it('GIFファイルを正しく読み取れる', async () => {
      createTmpDir();
      const gifData = Buffer.from('GIF89a', 'ascii');
      fs.writeFileSync(path.join(tmpDir, 'test.gif'), gifData);

      const { result } = await executeReadImage({ filePath: 'test.gif' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result.mediaType).toBe('image/gif');
    });

    it('WebPファイルを正しく読み取れる', async () => {
      createTmpDir();
      const webpData = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'ascii');
      fs.writeFileSync(path.join(tmpDir, 'test.webp'), webpData);

      const { result } = await executeReadImage({ filePath: 'test.webp' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result.mediaType).toBe('image/webp');
    });

    it('サポート外の形式ではエラーを返しサポート形式一覧を表示する', async () => {
      createTmpDir();
      fs.writeFileSync(path.join(tmpDir, 'image.svg'), '<svg></svg>');

      const { result } = await executeReadImage({ filePath: 'image.svg' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported image format');
      expect(result.message).toContain('PNG');
      expect(result.message).toContain('JPEG');
      expect(result.message).toContain('GIF');
      expect(result.message).toContain('WebP');
    });

    it('存在しないファイルではエラーを返す', async () => {
      createTmpDir();

      const { result } = await executeReadImage({ filePath: 'nonexistent.png' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.message).toContain('File not found');
    });

    it('パス走査はエラーを返す', async () => {
      createTmpDir();

      const { result } = await executeReadImage({ filePath: '../../etc/passwd.png' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.message).toContain('outside the project directory');
    });

    it('サブディレクトリ内のファイルを読み取れる', async () => {
      createTmpDir();
      const subDir = path.join(tmpDir, 'assets');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const { result } = await executeReadImage({ filePath: 'assets/icon.png' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('assets/icon.png');
    });

    it('成功時にmessageに画像情報が含まれる', async () => {
      createTmpDir();
      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      fs.writeFileSync(path.join(tmpDir, 'test.png'), pngData);

      const { result } = await executeReadImage({ filePath: 'test.png' }, tmpDir);

      expect(result.message).toContain('Successfully read image');
      expect(result.message).toContain('test.png');
      expect(result.message).toContain('image/png');
      expect(result.message).toContain('next user message');
    });
  });

  describe('pendingImages（RequestContextへの画像データ蓄積）', () => {
    it('成功時にRequestContextのpendingImagesに画像データが蓄積される', async () => {
      createTmpDir();
      const pngData = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      );
      fs.writeFileSync(path.join(tmpDir, 'test.png'), pngData);

      const { requestContext } = await executeReadImage({ filePath: 'test.png' }, tmpDir);

      const pendingImages = requestContext.get(PENDING_IMAGES_KEY) as PendingImageData[];
      expect(pendingImages).toHaveLength(1);
      expect(pendingImages[0].filePath).toBe('test.png');
      expect(pendingImages[0].base64Data).toBe(pngData.toString('base64'));
      expect(pendingImages[0].mediaType).toBe('image/png');
    });

    it('失敗時にpendingImagesに蓄積されない', async () => {
      createTmpDir();

      const { requestContext } = await executeReadImage({ filePath: 'nonexistent.png' }, tmpDir);

      const pendingImages = requestContext.get(PENDING_IMAGES_KEY) as
        | PendingImageData[]
        | undefined;
      expect(pendingImages ?? []).toHaveLength(0);
    });

    it('サポート外形式の場合、pendingImagesに蓄積されない', async () => {
      createTmpDir();
      fs.writeFileSync(path.join(tmpDir, 'image.svg'), '<svg></svg>');

      const { requestContext } = await executeReadImage({ filePath: 'image.svg' }, tmpDir);

      const pendingImages = requestContext.get(PENDING_IMAGES_KEY) as
        | PendingImageData[]
        | undefined;
      expect(pendingImages ?? []).toHaveLength(0);
    });

    it('複数回呼び出すと画像データが蓄積される', async () => {
      createTmpDir();
      fs.writeFileSync(path.join(tmpDir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(path.join(tmpDir, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

      // 同じRequestContextで2回呼び出す
      const executeFn = readImageTool.execute;
      if (!executeFn) throw new Error('execute is not defined');
      const requestContext = new RequestContext([['projectDir', tmpDir]]);
      const context = {
        requestContext,
      } as Parameters<NonNullable<typeof readImageTool.execute>>[1];

      await executeFn({ filePath: 'a.png' }, context);
      await executeFn({ filePath: 'b.jpg' }, context);

      const pendingImages = requestContext.get(PENDING_IMAGES_KEY) as PendingImageData[];
      expect(pendingImages).toHaveLength(2);
      expect(pendingImages[0].filePath).toBe('a.png');
      expect(pendingImages[0].mediaType).toBe('image/png');
      expect(pendingImages[1].filePath).toBe('b.jpg');
      expect(pendingImages[1].mediaType).toBe('image/jpeg');
    });
  });
});
