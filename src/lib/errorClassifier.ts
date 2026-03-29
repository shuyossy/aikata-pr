import { isContextLengthError, isApiCallError } from './aiApiError.js';

/**
 * エラー種別
 */
export type ErrorType = 'context_length' | 'api_call' | 'unknown';

/**
 * 分類されたエラー
 */
export interface ClassifiedError {
  type: ErrorType;
  message: string;
}

/**
 * その他エラー時のユーザ向け表示メッセージ
 */
export const UNEXPECTED_ERROR_MESSAGE = '予期せぬエラー（実行ログを確認してください）';

/**
 * エラーを種別に分類する
 *
 * 判定優先順位:
 * 1. コンテキスト長エラー（APICallError + responseBodyにパターン一致）
 * 2. API呼び出しエラー（APICallErrorが存在）
 * 3. その他のエラー
 *
 * レート制限エラー（429）はwithRateLimitRetryで処理済みのため、ここには到達しない前提。
 */
export function classifyError(error: unknown): ClassifiedError {
  if (isContextLengthError(error)) {
    const msg = error instanceof Error ? error.message : 'Context length exceeded';
    return { type: 'context_length', message: msg };
  }

  if (isApiCallError(error)) {
    const msg = error instanceof Error ? error.message : 'API call error';
    return { type: 'api_call', message: msg };
  }

  return { type: 'unknown', message: UNEXPECTED_ERROR_MESSAGE };
}
