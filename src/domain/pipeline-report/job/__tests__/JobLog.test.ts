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
  });
});
