import { randomUUID } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { ProcessInputStepArgs, ProcessInputStepResult } from '@mastra/core/processors';
import {
  PENDING_IMAGES_KEY,
  IMAGE_MESSAGE_PREFIX,
  type PendingImageData,
} from './readImageCommon.js';

/**
 * prepareStep関数を構築する: readImage / getArtifactContent ツールで取得した画像をuserメッセージとして注入する
 *
 * Chat Completions APIではtoolロールのメッセージにマルチモーダルコンテンツを含められないため、
 * prepareStepフックを利用してuserメッセージとして画像を注入する。
 *
 * review / pipeline-report 両機能で共用可能な汎用実装。
 *
 * @param requestContext - pendingImagesを含むRequestContext
 * @returns prepareStep関数。pendingImagesがあればuserメッセージとして画像を注入し、なければ変更なし。
 */
export function buildPrepareStepForImageInjection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestContext: RequestContext<any>,
): (args: ProcessInputStepArgs) => ProcessInputStepResult | undefined {
  return ({ messages }) => {
    const pendingImages: PendingImageData[] = requestContext.get(PENDING_IMAGES_KEY) ?? [];

    if (pendingImages.length === 0) {
      return undefined;
    }

    // pendingImagesをクリア
    requestContext.set(PENDING_IMAGES_KEY, []);

    // ファイルパスの番号付きリストを構築
    const fileList = pendingImages.map((img, i) => `${i + 1}. ${img.filePath}`).join('\n');

    // MastraDBMessage形式で画像付きuserメッセージを構築
    // 画像はv4 FileUIPart形式（type: 'file', mimeType, data）で格納する
    const imageUserMessage: MastraDBMessage = {
      id: randomUUID(),
      role: 'user',
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          {
            type: 'text' as const,
            text:
              `${IMAGE_MESSAGE_PREFIX} the following ${pendingImages.length} image(s). ` +
              `Each image is displayed in the order listed below. ` +
              `Please continue your analysis using these images.\n\n` +
              fileList,
          },
          ...pendingImages.map((img) => ({
            type: 'file' as const,
            mimeType: img.mediaType,
            data: img.base64Data,
          })),
        ],
      },
    };

    return { messages: [...messages, imageUserMessage] };
  };
}
