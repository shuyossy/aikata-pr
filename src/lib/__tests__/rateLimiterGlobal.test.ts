import { describe, it, expect, afterEach } from 'vitest';
import {
  initializeRateLimiter,
  getRateLimiter,
  getRateLimiterOrNull,
  resetRateLimiter,
  RateLimitExhaustedError,
} from '../rateLimiterGlobal.js';
import { RateLimiter } from '../../infrastructure/adapter/rateLimiter/RateLimiter.js';

describe('rateLimiterGlobal', () => {
  afterEach(() => {
    resetRateLimiter();
  });

  describe('initializeRateLimiter', () => {
    it('初期化後にgetRateLimiterで取得できること', () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 60 });
      initializeRateLimiter(limiter);

      expect(getRateLimiter()).toBe(limiter);
    });

    it('二重初期化でエラーをスローすること', () => {
      initializeRateLimiter(new RateLimiter({ rateLimitPerMin: 60 }));

      expect(() => initializeRateLimiter(new RateLimiter({ rateLimitPerMin: 60 }))).toThrow(
        'RateLimiter is already initialized',
      );
    });
  });

  describe('getRateLimiter', () => {
    it('未初期化でエラーをスローすること', () => {
      expect(() => getRateLimiter()).toThrow('RateLimiter is not initialized');
    });
  });

  describe('getRateLimiterOrNull', () => {
    it('未初期化でnullを返すこと', () => {
      expect(getRateLimiterOrNull()).toBeNull();
    });

    it('初期化後にインスタンスを返すこと', () => {
      const limiter = new RateLimiter({ rateLimitPerMin: 60 });
      initializeRateLimiter(limiter);

      expect(getRateLimiterOrNull()).toBe(limiter);
    });
  });

  describe('resetRateLimiter', () => {
    it('リセット後に再初期化できること', () => {
      initializeRateLimiter(new RateLimiter({ rateLimitPerMin: 60 }));
      resetRateLimiter();

      const newLimiter = new RateLimiter({ rateLimitPerMin: 120 });
      initializeRateLimiter(newLimiter);

      expect(getRateLimiter()).toBe(newLimiter);
    });
  });
});

describe('RateLimitExhaustedError', () => {
  it('nameがRateLimitExhaustedErrorであること', () => {
    const error = new RateLimitExhaustedError('test message');

    expect(error.name).toBe('RateLimitExhaustedError');
    expect(error.message).toBe('test message');
    expect(error).toBeInstanceOf(Error);
  });
});
