import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  isSupportedImageFormat,
  getMediaType,
  getSupportedFormatsMessage,
} from '../../../lib/imageFormat.js';

/**
 * ツールキー名（reviewAgentToolsオブジェクトのキー名）
 * メッセージシリアライズ時のtoolName照合にも使用する
 */
export const READ_IMAGE_TOOL_KEY = 'readImage';

/**
 * RequestContextに蓄積される画像データの型
 * prepareStepで取得してuserメッセージとして注入する
 */
export interface PendingImageData {
  filePath: string;
  base64Data: string;
  mediaType: string;
}

/**
 * RequestContextのpendingImagesキー名
 */
export const PENDING_IMAGES_KEY = 'pendingImages';

/**
 * prepareStepで注入される画像付きuserメッセージの識別プレフィックス
 * contextLengthRecoveryでの画像抽出時にも使用する
 */
export const IMAGE_MESSAGE_PREFIX = 'The readImage tool was used to retrieve';

/**
 * readImageツールの出力スキーマ
 * base64DataはRequestContextに蓄積するため、出力には含めない
 */
const readImageOutputSchema = z.object({
  success: z.boolean(),
  filePath: z.string(),
  mediaType: z.string().optional(),
  message: z.string().optional(),
});

/**
 * プロジェクト内の画像ファイルを読み取るMastra Tool
 * projectDirはRequestContextから取得する
 * 画像データはRequestContextのpendingImagesに蓄積し、prepareStepでuserメッセージとして注入する
 */
export const readImageTool = createTool({
  id: 'read-image',
  description:
    'Read an image file from the project and return it as image data for visual analysis.',
  inputSchema: z.object({
    filePath: z.string().describe('Path to the image file, relative to the project root directory'),
  }),
  outputSchema: readImageOutputSchema,
  execute: async ({ filePath }, context) => {
    const projectDir = context?.requestContext?.get('projectDir');
    if (typeof projectDir !== 'string' || projectDir === '') {
      return {
        success: false,
        filePath,
        message: 'projectDir is not configured in RequestContext',
      };
    }

    const absolutePath = path.resolve(projectDir, filePath);
    const resolvedProjectDir = path.resolve(projectDir);

    // パス走査防止: projectDir内のパスであることを確認
    if (
      !absolutePath.startsWith(resolvedProjectDir + path.sep) &&
      absolutePath !== resolvedProjectDir
    ) {
      return {
        success: false,
        filePath,
        message: `Path "${filePath}" is outside the project directory`,
      };
    }

    // サポートされている形式かチェック
    if (!isSupportedImageFormat(absolutePath)) {
      return {
        success: false,
        filePath,
        message: `Unsupported image format. ${getSupportedFormatsMessage()}`,
      };
    }

    // ファイル存在チェック
    try {
      await fs.access(absolutePath);
    } catch {
      return {
        success: false,
        filePath,
        message: `File not found: ${filePath}`,
      };
    }

    // メディアタイプ取得
    const mediaType = getMediaType(absolutePath);
    if (!mediaType) {
      return {
        success: false,
        filePath,
        message: `Failed to determine media type for ${filePath}`,
      };
    }

    // ファイル読み取り
    const buffer = await fs.readFile(absolutePath);
    const base64Data = buffer.toString('base64');

    // RequestContextにpending画像データを蓄積（prepareStepでuserメッセージとして注入するため）
    const existing = context?.requestContext?.get(PENDING_IMAGES_KEY);
    const pendingImages: PendingImageData[] = Array.isArray(existing) ? existing : [];
    pendingImages.push({ filePath, base64Data, mediaType });
    context?.requestContext?.set(PENDING_IMAGES_KEY, pendingImages);

    return {
      success: true,
      filePath,
      mediaType,
      message: `Successfully read image: ${filePath} (${mediaType}). The image content is provided in the next user message.`,
    };
  },
});
