import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { errWithCause } from 'pino-std-serializers';

/**
 * ロガー初期化時の設定
 */
export interface LoggerConfig {
  /** ユーザID（全てのログ出力に付与される） */
  userId: string;
  /** ログレベル（デフォルト: 'info'） */
  level?: pino.LevelWithSilentOrString;
  /** pino-prettyによる整形出力（デフォルト: true） */
  prettyPrint?: boolean;
  /** テスト用カスタムストリーム */
  stream?: pino.DestinationStream;
}

/**
 * アプリケーション全体で利用するロガーの型
 */
export type AppLogger = pino.Logger;

/** シングルトンロガーインスタンス */
let loggerInstance: AppLogger | null = null;

/**
 * リクエスト単位のログコンテキスト用AsyncLocalStorage
 *
 * APIサーバーで各リクエストに固有のログバインディング（userId, requestId等）を
 * 下流コードに自動伝播させるために利用する。`runWithLogContext()`で包まれた
 * 同期/非同期チェーン内部で`getLogger()`を呼び出すと、ベースロガーに本コンテキスト
 * のバインディングが適用された子ロガーが返る。
 */
const logContextStorage = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * リクエスト単位のログバインディングを設定し、関数`fn`を実行する
 * `fn`内部の（同期/非同期問わず）`getLogger()`呼び出しは、与えたバインディングを
 * 持つ子ロガーを返すようになる。ネストした`runWithLogContext`は外側のバインディングを
 * 上書き合成する。
 *
 * @param bindings - ログに付与する追加フィールド
 * @param fn - コンテキスト内部で実行する関数
 * @returns `fn`の返り値
 */
export function runWithLogContext<T>(bindings: Record<string, unknown>, fn: () => T): T {
  const parent = logContextStorage.getStore();
  const merged: Record<string, unknown> = parent ? { ...parent, ...bindings } : { ...bindings };
  return logContextStorage.run(merged, fn);
}

/**
 * ロガーを初期化する
 * userIdをバインドしたシングルトンロガーを生成する
 *
 * @param config - ロガー初期化設定
 * @returns 初期化されたロガーインスタンス
 */
export function initializeLogger(config: LoggerConfig): AppLogger {
  // 二重初期化を防止（resetLogger()を呼んでからやり直すこと）
  if (loggerInstance) {
    throw new Error('Logger is already initialized. Call resetLogger() before re-initializing.');
  }

  const { userId, level = 'info', prettyPrint = true, stream } = config;

  // pinoのベースオプション
  const pinoOptions: pino.LoggerOptions = {
    name: 'aikata-pr',
    level,
    serializers: {
      // errWithCauseでcauseチェーンを再帰的にシリアライズ
      err: errWithCause,
    },
  };

  // ストリームの決定（テスト時はカスタムストリーム、通常はpretty or stdout）
  const destination: pino.DestinationStream | undefined = stream;

  let baseLogger: pino.Logger;

  if (destination) {
    // カスタムストリーム指定時（テスト用など）
    baseLogger = pino(pinoOptions, destination);
  } else if (prettyPrint) {
    // pino-prettyを同期ストリームとして利用（transportはthread-streamを使うためesbuildバンドルと非互換）
    const prettyStream = pinoPretty({
      colorize: true,
      levelFirst: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard',
      singleLine: false,
    });
    baseLogger = pino(pinoOptions, prettyStream);
  } else {
    // JSON出力（整形なし）
    baseLogger = pino(pinoOptions);
  }

  // userIdをバインドした子ロガーを生成
  loggerInstance = baseLogger.child({ userId });

  return loggerInstance;
}

/**
 * 初期化済みのロガーを取得する
 * initializeLoggerが呼ばれていない場合はエラーをスローする
 *
 * `runWithLogContext`の内部で呼び出された場合は、現在のコンテキストバインディングを
 * 適用した子ロガーを返す。外部では従来通りシングルトンインスタンスを返す。
 *
 * @returns ロガーインスタンス
 * @throws {Error} ロガーが未初期化の場合
 */
export function getLogger(): AppLogger {
  if (!loggerInstance) {
    throw new Error('Logger is not initialized. Call initializeLogger() first.');
  }
  const contextBindings = logContextStorage.getStore();
  if (contextBindings && Object.keys(contextBindings).length > 0) {
    return loggerInstance.child(contextBindings);
  }
  return loggerInstance;
}

/**
 * ロガーのバッファをフラッシュする
 * process.exit()前に呼び出して全てのログが書き込まれることを保証する
 */
export function flushLogger(): void {
  if (loggerInstance) {
    loggerInstance.flush();
  }
}

/**
 * ロガーをリセットする（テスト用）
 * シングルトンインスタンスを破棄する
 */
export function resetLogger(): void {
  loggerInstance = null;
}
