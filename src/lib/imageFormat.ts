import * as path from 'node:path';

/**
 * サポート対象の画像拡張子一覧
 */
export const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * 拡張子からメディアタイプへのマッピング
 */
const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * ファイルパスがサポート対象の画像形式かどうかを判定する
 */
export function isSupportedImageFormat(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in EXTENSION_TO_MEDIA_TYPE;
}

/**
 * ファイルパスからメディアタイプを取得する
 * サポート外の形式の場合はnullを返す
 */
export function getMediaType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[ext] ?? null;
}

/**
 * サポート対象の画像形式を説明するメッセージを返す
 */
export function getSupportedFormatsMessage(): string {
  return 'Supported formats: PNG, JPEG, GIF, WebP';
}

/**
 * folderTree文字列内にサポート対象の画像ファイルが含まれるかを判定する
 */
export function containsImageFiles(folderTree: string): boolean {
  if (!folderTree) return false;
  const pattern = new RegExp(
    `\\.(${SUPPORTED_IMAGE_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})(?:\\s|$)`,
    'im',
  );
  return pattern.test(folderTree);
}
