import { describe, it, expect } from 'vitest';
import { JobLog } from '../JobLog.js';

describe('JobLog', () => {
  describe('full', () => {
    it('全文ログはomittedRangeがnullでtotalCharsが文字数と等しい', () => {
      const text = 'line1\nline2\nline3';
      const log = JobLog.full(42, text);

      expect(log.jobId).toBe(42);
      expect(log.compressedText).toBe(text);
      expect(log.omittedRange).toBeNull();
      expect(log.totalChars).toBe(text.length);
    });

    it('空文字でもfullとして作成できる', () => {
      const log = JobLog.full(1, '');
      expect(log.compressedText).toBe('');
      expect(log.totalChars).toBe(0);
      expect(log.omittedRange).toBeNull();
    });
  });

  describe('compressed', () => {
    it('圧縮ログはomittedRangeを保持する', () => {
      const log = JobLog.compressed({
        jobId: 7,
        compressedText: 'head...tail',
        omittedRange: { startChar: 100, endChar: 900 },
        totalChars: 1000,
      });

      expect(log.jobId).toBe(7);
      expect(log.compressedText).toBe('head...tail');
      expect(log.omittedRange).toEqual({ startChar: 100, endChar: 900 });
      expect(log.totalChars).toBe(1000);
    });

    it('omittedRange.startChar > endCharの場合はエラーになる', () => {
      expect(() =>
        JobLog.compressed({
          jobId: 1,
          compressedText: 'head...tail',
          omittedRange: { startChar: 900, endChar: 100 },
          totalChars: 1000,
        }),
      ).toThrow(/omittedRange\.startChar must be <= endChar/);
    });

    it('omittedRange.endChar > totalCharsの場合はエラーになる', () => {
      expect(() =>
        JobLog.compressed({
          jobId: 1,
          compressedText: 'head...tail',
          omittedRange: { startChar: 100, endChar: 2000 },
          totalChars: 1000,
        }),
      ).toThrow(/omittedRange\.endChar must be <= totalChars/);
    });

    it('totalChars < compressedText.lengthの場合はエラーになる', () => {
      expect(() =>
        JobLog.compressed({
          jobId: 1,
          compressedText: 'head...tail',
          omittedRange: { startChar: 1, endChar: 5 },
          totalChars: 3,
        }),
      ).toThrow(/totalChars must be >= compressedText\.length/);
    });
  });
});
