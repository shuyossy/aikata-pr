/**
 * 複数機能で共用するreadImage系Toolの定数
 *
 * - PENDING_IMAGES_KEY: RequestContextに蓄積される画像データのキー名
 * - READ_IMAGE_TOOL_KEY: ツールキー名（Agent登録時のキー・toolName照合に利用）
 * - IMAGE_MESSAGE_PREFIX: prepareStepで注入されるuserメッセージの識別プレフィックス
 */
export const PENDING_IMAGES_KEY = 'pendingImages';
export const READ_IMAGE_TOOL_KEY = 'readImage';
export const IMAGE_MESSAGE_PREFIX = 'The readImage tool was used to retrieve';
