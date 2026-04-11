import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getMediaType, isSupportedImageFormat } from '../../../lib/imageFormat.js';
import type { ArtifactArchiveReader } from '../../../application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.js';

/**
 * RequestContextでアーティファクトzipキャッシュパスを保持するキー
 */
export const ARTIFACT_CACHE_PATHS_KEY = 'artifactCachePaths';

/**
 * RequestContextでArtifactArchiveReader実装を注入するキー
 * テスト時はfake readerを注入可能
 */
export const ARTIFACT_ARCHIVE_READER_KEY = 'artifactArchiveReader';

/**
 * RequestContextで画像base64データを蓄積するキー
 * readImageToolと同様に `Map<string, { base64, mimeType }>` 形式
 */
export const PENDING_IMAGES_KEY = 'pendingImages';

/**
 * デフォルトの最大読み取りバイト数（2 MiB）
 */
const DEFAULT_MAX_ARTIFACT_FILE_BYTES = 2 * 1024 * 1024;

/**
 * マジックバイトから画像MIMEタイプを検出する
 * PNG/JPEG/GIF/WebPのみサポート
 */
function detectImageMimeFromMagicBytes(buf: Buffer): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38 (GIF8)
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP")
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 画像MIME判定: 拡張子 または マジックバイトで判定する
 */
function detectImageMime(artifactPath: string, data: Buffer): string | null {
  // 拡張子による判定を優先（高速）
  if (isSupportedImageFormat(artifactPath)) {
    const byExt = getMediaType(artifactPath);
    if (byExt) return byExt;
  }
  // フォールバックとしてマジックバイト判定
  return detectImageMimeFromMagicBytes(data);
}

/**
 * バッファがUTF-8テキストとしてデコード可能か判定する
 */
function isUtf8Text(data: Buffer): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * アーティファクト内のファイルを取得し、テキスト/画像/非対応/エラーのいずれかで返すMastra Tool
 */
export const getArtifactContentTool = createTool({
  id: 'get-artifact-content',
  description:
    'Fetch the content of a file inside a job artifact archive. ' +
    'Returns text content for UTF-8 decodable files, image metadata (with the image injected into the next user message) for supported image formats (PNG/JPEG/GIF/WebP), or an unsupported indicator for binary files.',
  inputSchema: z.object({
    jobId: z.number().describe('Target job ID'),
    artifactPath: z.string().describe('Path of the file inside the artifact archive'),
  }),
  outputSchema: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('text'),
      content: z.string(),
      truncated: z.boolean(),
    }),
    z.object({
      kind: z.literal('image'),
      mimeType: z.string(),
    }),
    z.object({
      kind: z.literal('unsupported'),
      mimeType: z.string(),
      size: z.number(),
      reason: z.string(),
    }),
    z.object({
      kind: z.literal('error'),
      reason: z.string(),
    }),
  ]),
  execute: async ({ jobId, artifactPath }, context) => {
    // RequestContextからキャッシュパス・readerを取得
    const artifactCachePaths = context?.requestContext?.get(ARTIFACT_CACHE_PATHS_KEY) as
      | Map<number, string | null>
      | undefined;
    const archiveReader = context?.requestContext?.get(ARTIFACT_ARCHIVE_READER_KEY) as
      | ArtifactArchiveReader
      | undefined;

    if (!artifactCachePaths) {
      return { kind: 'error' as const, reason: 'artifactCachePaths is not configured' };
    }
    if (!archiveReader) {
      return { kind: 'error' as const, reason: 'artifactArchiveReader is not configured' };
    }

    const zipPath = artifactCachePaths.get(jobId);
    if (!zipPath) {
      return {
        kind: 'error' as const,
        reason: 'artifact zip was not cached for this job',
      };
    }

    // 最大バイト数（環境変数優先）
    const envMax = Number(process.env.PIPELINE_REPORT_MAX_ARTIFACT_FILE_BYTES);
    const maxBytes =
      Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_ARTIFACT_FILE_BYTES;

    let readResult: { data: Buffer; truncated: boolean };
    try {
      readResult = await archiveReader.readFile(zipPath, artifactPath, { maxBytes });
    } catch (err) {
      return {
        kind: 'error' as const,
        reason: err instanceof Error ? err.message : 'Failed to read artifact entry',
      };
    }

    const { data, truncated } = readResult;

    // 画像判定
    const imageMime = detectImageMime(artifactPath, data);
    if (imageMime) {
      const base64 = data.toString('base64');
      const pendingImages = context?.requestContext?.get(PENDING_IMAGES_KEY) as
        | Map<string, { base64: string; mimeType: string }>
        | undefined;
      if (pendingImages instanceof Map) {
        pendingImages.set(`${jobId}:${artifactPath}`, { base64, mimeType: imageMime });
      }
      return { kind: 'image' as const, mimeType: imageMime };
    }

    // テキスト判定
    if (isUtf8Text(data)) {
      return {
        kind: 'text' as const,
        content: data.toString('utf8'),
        truncated,
      };
    }

    // それ以外はバイナリ扱い
    return {
      kind: 'unsupported' as const,
      mimeType: 'application/octet-stream',
      size: data.length,
      reason: 'binary content cannot be displayed',
    };
  },
});
