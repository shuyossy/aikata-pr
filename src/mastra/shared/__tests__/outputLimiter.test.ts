import { describe, it, expect } from 'vitest';
import { applyOutputLimit, DEFAULT_MAX_OUTPUT_TOKENS } from '../outputLimiter.js';

/**
 * テスト用の簡易トークンカウンター
 * 1トークン = 4文字として計算（deterministic & fast）
 */
const mockCountTokens = (text: string): number => Math.ceil(text.length / 4);

describe('applyOutputLimit', () => {
  describe('基本動作', () => {
    it('空文字列の場合はtotalLines=0, truncated=falseを返す', () => {
      const result = applyOutputLimit('', { countTokens: mockCountTokens });
      expect(result.truncated).toBe(false);
      expect(result.totalLines).toBe(0);
      expect(result.shownLines).toBe(0);
      expect(result.text).toBe('');
      expect(result.tokenInfo).toBeUndefined();
    });

    it('小さいテキストはそのまま返却される（truncated=false）', () => {
      const content = 'line1\nline2\nline3';
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 1000,
      });
      expect(result.truncated).toBe(false);
      expect(result.totalLines).toBe(3);
      expect(result.shownLines).toBe(3);
      expect(result.tokenInfo).toBeUndefined();
    });

    it('デフォルトのmaxOutputTokensが使用される', () => {
      expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(4000);
    });
  });

  describe('行番号付与', () => {
    it('デフォルトで行番号が付与される', () => {
      const content = 'aaa\nbbb\nccc';
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 10000,
      });
      expect(result.text).toBe('1| aaa\n2| bbb\n3| ccc');
    });

    it('行番号は総行数の桁数に合わせて右揃えされる', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
      const content = lines.join('\n');
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 100000,
      });
      // 100行 → 3桁に右揃え
      expect(result.text).toContain('  1| line1');
      expect(result.text).toContain(' 10| line10');
      expect(result.text).toContain('100| line100');
    });

    it('showLineNumbers=falseで行番号なし', () => {
      const content = 'aaa\nbbb\nccc';
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 10000,
        showLineNumbers: false,
      });
      expect(result.text).toBe('aaa\nbbb\nccc');
    });
  });

  describe('トークン制限による切り詰め', () => {
    it('トークン上限を超えるテキストが切り詰められる', () => {
      // 各行が十分長いテキスト（mockCountTokensは4文字=1トークン）
      const lines = Array.from(
        { length: 50 },
        (_, i) => `This is a long line number ${i + 1} with some content padding here`,
      );
      const content = lines.join('\n');
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 100, // 非常に小さい制限
      });

      expect(result.truncated).toBe(true);
      expect(result.shownLines).toBeLessThan(result.totalLines);
      expect(result.totalLines).toBe(50);
      expect(result.tokenInfo).toBeDefined();
      expect(result.tokenInfo!.shown).toBeLessThanOrEqual(100);
      expect(result.tokenInfo!.total).toBeGreaterThan(100);
    });

    it('切り詰め通知が末尾に付加される', () => {
      const lines = Array.from(
        { length: 50 },
        (_, i) => `Line ${i + 1}: some content here for testing`,
      );
      const content = lines.join('\n');
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 100,
      });

      expect(result.text).toContain('[output truncated: showing first');
      expect(result.text).toContain('tokens');
      expect(result.text).toContain('lines)');
      expect(result.text).toContain('startLine/maxLines');
    });

    it('切り詰めは行境界を守る（行の途中で切れない）', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Complete line ${i + 1}`);
      const content = lines.join('\n');
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 50,
      });

      // 切り詰め通知を除いた部分が完全な行で構成されていることを確認
      const textBeforeTruncationNotice = result.text.split('\n[output truncated:')[0]!;
      const outputLines = textBeforeTruncationNotice.split('\n');
      // 各行が行番号パターンで始まることを確認
      for (const line of outputLines) {
        expect(line).toMatch(/^\s*\d+\| /);
      }
    });

    it('カスタムmaxOutputTokensが尊重される', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      const content = lines.join('\n');

      const smallLimit = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 10,
      });
      const largeLimit = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 100000,
      });

      expect(smallLimit.truncated).toBe(true);
      expect(largeLimit.truncated).toBe(false);
    });

    it('カスタムcountTokens関数が使用される', () => {
      const content = 'abc';
      // 1文字=1トークンとするカスタムカウンター
      const charCounter = (text: string) => text.length;

      const result = applyOutputLimit(content, {
        countTokens: charCounter,
        maxOutputTokens: 5, // "1| abc" = 6文字 → 切り詰め
      });

      expect(result.truncated).toBe(true);
    });
  });

  describe('トークン情報の正確性', () => {
    it('truncated=falseの場合はtokenInfoが含まれない', () => {
      const result = applyOutputLimit('small', {
        countTokens: mockCountTokens,
        maxOutputTokens: 10000,
      });
      expect(result.tokenInfo).toBeUndefined();
    });

    it('truncated=trueの場合はtokenInfoにshownとtotalが含まれる', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Content line ${i + 1} with padding`);
      const content = lines.join('\n');
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 50,
      });

      expect(result.tokenInfo).toBeDefined();
      expect(result.tokenInfo!.shown).toBeGreaterThan(0);
      expect(result.tokenInfo!.total).toBeGreaterThan(result.tokenInfo!.shown);
    });
  });

  describe('エッジケース', () => {
    it('1行のみのテキストが上限以下の場合はそのまま返却', () => {
      const result = applyOutputLimit('single line', {
        countTokens: mockCountTokens,
        maxOutputTokens: 10000,
      });
      expect(result.truncated).toBe(false);
      expect(result.totalLines).toBe(1);
      expect(result.shownLines).toBe(1);
      expect(result.text).toBe('1| single line');
    });

    it('1行のみが上限超過の場合でも少なくとも1行は返す', () => {
      // 非常に長い1行
      const longLine = 'x'.repeat(10000);
      const result = applyOutputLimit(longLine, {
        countTokens: mockCountTokens,
        maxOutputTokens: 10,
      });
      // 少なくとも1行は表示される（切り詰め通知とともに）
      expect(result.shownLines).toBe(1);
      expect(result.truncated).toBe(true);
    });

    it('全行がちょうど上限トークンの場合はtruncated=false', () => {
      const content = 'ab'; // "1| ab" = 5文字 → mockCountTokensで2トークン
      const result = applyOutputLimit(content, {
        countTokens: mockCountTokens,
        maxOutputTokens: 2,
      });
      expect(result.truncated).toBe(false);
    });
  });
});
