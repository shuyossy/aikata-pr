import { describe, it, expect, beforeEach } from 'vitest';
import { initializeLogger, getLogger, resetLogger, flushLogger } from '../logger.js';

describe('Logger', () => {
  beforeEach(() => {
    // テスト間でシングルトンをリセット
    resetLogger();
  });

  describe('initializeLogger', () => {
    it('userIdを指定して初期化するとロガーが生成される', () => {
      const logger = initializeLogger({ userId: 'user-001', prettyPrint: false });
      expect(logger).toBeDefined();
      expect(logger.info).toBeTypeOf('function');
      expect(logger.error).toBeTypeOf('function');
      expect(logger.warn).toBeTypeOf('function');
      expect(logger.debug).toBeTypeOf('function');
    });

    it('ログレベルを指定して初期化できる', () => {
      const logger = initializeLogger({ userId: 'user-001', level: 'debug', prettyPrint: false });
      expect(logger).toBeDefined();
    });

    it('prettyPrint無効かつカスタムストリーム未指定の場合もロガーが生成される', () => {
      const logger = initializeLogger({ userId: 'user-001', prettyPrint: false });
      expect(logger).toBeDefined();
      expect(logger.info).toBeTypeOf('function');
    });

    it('prettyPrint有効でロガーが生成される', () => {
      const logger = initializeLogger({ userId: 'user-001', prettyPrint: true });
      expect(logger).toBeDefined();
      expect(logger.info).toBeTypeOf('function');
    });

    it('既に初期化済みの場合に再初期化するとエラーをスローする', () => {
      initializeLogger({ userId: 'user-001', prettyPrint: false });
      expect(() => initializeLogger({ userId: 'user-002' })).toThrowError(
        'Logger is already initialized. Call resetLogger() before re-initializing.',
      );
    });

    it('resetLogger後に再初期化すると正常にロガーが生成される', () => {
      initializeLogger({ userId: 'user-001', prettyPrint: false });
      resetLogger();
      const logger = initializeLogger({ userId: 'user-002', prettyPrint: false });
      expect(logger).toBeDefined();
    });
  });

  describe('getLogger', () => {
    it('initializeLoggerが呼ばれる前に呼び出すとエラーをスローする', () => {
      expect(() => getLogger()).toThrowError(
        'Logger is not initialized. Call initializeLogger() first.',
      );
    });

    it('initializeLogger後に呼び出すと同一インスタンスを返す', () => {
      initializeLogger({ userId: 'user-001', prettyPrint: false });
      const logger1 = getLogger();
      const logger2 = getLogger();
      expect(logger1).toBe(logger2);
    });

    it('initializeLoggerの戻り値とgetLoggerの戻り値が同一インスタンスである', () => {
      const initialized = initializeLogger({ userId: 'user-001', prettyPrint: false });
      const retrieved = getLogger();
      expect(initialized).toBe(retrieved);
    });
  });

  describe('ログ出力内容', () => {
    it('ログ出力にuserIdが含まれる', () => {
      const logs: string[] = [];
      const logger = initializeLogger({
        userId: 'user-abc',
        // テスト用のストリーム（pino-prettyを無効にしてJSON出力）
        prettyPrint: false,
        stream: {
          write(chunk: string) {
            logs.push(chunk);
          },
        },
      });

      logger.info('test message');

      expect(logs.length).toBeGreaterThan(0);
      const logEntry = JSON.parse(logs[0]!);
      expect(logEntry.userId).toBe('user-abc');
    });

    it('ログ出力にタイムスタンプが含まれる', () => {
      const logs: string[] = [];
      const logger = initializeLogger({
        userId: 'user-xyz',
        prettyPrint: false,
        stream: {
          write(chunk: string) {
            logs.push(chunk);
          },
        },
      });

      logger.info('timestamp test');

      expect(logs.length).toBeGreaterThan(0);
      const logEntry = JSON.parse(logs[0]!);
      // pinoのデフォルトではtimeフィールドにエポックミリ秒が含まれる
      expect(logEntry.time).toBeTypeOf('number');
    });
  });

  describe('エラーシリアライゼーション', () => {
    it('errWithCauseでcauseチェーンがシリアライズされる', () => {
      const logs: string[] = [];
      const logger = initializeLogger({
        userId: 'user-err',
        prettyPrint: false,
        stream: {
          write(chunk: string) {
            logs.push(chunk);
          },
        },
      });

      const rootCause = new Error('root cause');
      const wrappedError = new Error('wrapped error', { cause: rootCause });

      // pinoのAPI: mergingObjectを第1引数、メッセージを第2引数に渡す
      logger.error({ err: wrappedError }, 'error occurred');

      expect(logs.length).toBeGreaterThan(0);
      const logEntry = JSON.parse(logs[0]!);
      // errWithCauseはcauseを再帰的にシリアライズする
      expect(logEntry.err).toBeDefined();
      expect(logEntry.err.message).toBe('wrapped error');
      expect(logEntry.err.type).toBe('Error');
      // causeが再帰的にシリアライズされている
      expect(logEntry.err.cause).toBeDefined();
      expect(logEntry.err.cause.message).toBe('root cause');
    });

    it('causeのないエラーも正しくシリアライズされる', () => {
      const logs: string[] = [];
      const logger = initializeLogger({
        userId: 'user-err2',
        prettyPrint: false,
        stream: {
          write(chunk: string) {
            logs.push(chunk);
          },
        },
      });

      const simpleError = new Error('simple error');

      // pinoのAPI: mergingObjectを第1引数、メッセージを第2引数に渡す
      logger.error({ err: simpleError }, 'simple error occurred');

      expect(logs.length).toBeGreaterThan(0);
      const logEntry = JSON.parse(logs[0]!);
      expect(logEntry.err).toBeDefined();
      expect(logEntry.err.message).toBe('simple error');
      expect(logEntry.err.type).toBe('Error');
    });
  });

  describe('flushLogger', () => {
    it('初期化済みのロガーに対して例外をスローしない', () => {
      initializeLogger({ userId: 'user-001', prettyPrint: false });
      expect(() => flushLogger()).not.toThrow();
    });

    it('未初期化の状態で呼び出しても例外をスローしない', () => {
      expect(() => flushLogger()).not.toThrow();
    });
  });

  describe('resetLogger', () => {
    it('resetLogger後にgetLoggerを呼ぶとエラーをスローする', () => {
      initializeLogger({ userId: 'user-001', prettyPrint: false });
      expect(() => getLogger()).not.toThrow();

      resetLogger();

      expect(() => getLogger()).toThrowError(
        'Logger is not initialized. Call initializeLogger() first.',
      );
    });
  });
});
