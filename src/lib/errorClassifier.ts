import { isContextLengthError, isApiCallError } from './aiApiError.js';
import { isRateLimitError } from './rateLimitRetry.js';

/**
 * エラー種別
 */
export type ErrorType = 'context_length' | 'rate_limit' | 'api_call' | 'unknown';

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
 * Agentによるレビュー漏れ時のユーザ向け表示メッセージ
 */
export const REVIEW_MISSED_MESSAGE =
  '本チェック項目のレビューが完了しませんでした。再度実行してください';

/**
 * エラーを種別に分類する
 *
 * 判定優先順位:
 * 1. コンテキスト長エラー（APICallError + responseBodyにパターン一致）
 * 2. レート制限エラー（statusCode 429 または responseBodyに"rate limit"を含む）
 * 3. API呼び出しエラー（APICallErrorが存在）
 * 4. その他のエラー
 */
export function classifyError(error: unknown): ClassifiedError {
  if (isContextLengthError(error)) {
    const msg = error instanceof Error ? error.message : 'Context length exceeded';
    return { type: 'context_length', message: msg };
  }

  if (isRateLimitError(error)) {
    const msg = error instanceof Error ? error.message : 'Rate limit exceeded';
    return { type: 'rate_limit', message: msg };
  }

  if (isApiCallError(error)) {
    const msg = error instanceof Error ? error.message : 'API call error';
    return { type: 'api_call', message: msg };
  }

  return { type: 'unknown', message: UNEXPECTED_ERROR_MESSAGE };
}
