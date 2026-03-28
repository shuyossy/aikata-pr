import { APICallError } from 'ai';

/**
 * APICallErrorをエラーチェーンから抽出する
 *
 * 以下のケースに対応:
 * 1. 直接のAPICallError
 * 2. Error.causeがAPICallError（MastraErrorはError.causeにオリジナルエラーを保持するため、
 *    汎用的なError.causeチェーンの探索でカバーされる）
 * 3. Error.causeがRetryError相当（errorsプロパティを持つ）で、配列内にAPICallError
 *    （RetryErrorはダックタイピングで検出し、aiパッケージへの依存を回避）
 * 4. causeチェーンを再帰的に辿る
 */
export function extractAPICallError(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) {
    return error;
  }

  if (error instanceof Error && error.cause) {
    if (APICallError.isInstance(error.cause)) {
      return error.cause;
    }

    // RetryError相当: errorsプロパティを持つErrorオブジェクト
    if (
      error.cause instanceof Error &&
      'errors' in error.cause &&
      Array.isArray((error.cause as unknown as { errors: unknown[] }).errors)
    ) {
      for (const e of (error.cause as unknown as { errors: unknown[] }).errors) {
        if (APICallError.isInstance(e)) {
          return e;
        }
      }
    }

    // causeチェーンを再帰的に辿る
    return extractAPICallError(error.cause);
  }

  return null;
}

/**
 * エラーチェーン内のstatusCodeをダックタイピングで検出する
 *
 * APICallError.isInstance()はSymbolベースの型チェックを行うため、
 * @ai-sdk/providerのバージョンが異なるとインスタンス判定に失敗する場合がある。
 * フォールバックとしてstatusCodeプロパティを直接チェックする。
 */
export function findStatusCodeInChain(error: unknown): number | null {
  if (!(error instanceof Error)) return null;

  if ('statusCode' in error && typeof (error as { statusCode: unknown }).statusCode === 'number') {
    return (error as { statusCode: number }).statusCode;
  }

  if (error.cause) {
    return findStatusCodeInChain(error.cause);
  }

  return null;
}
