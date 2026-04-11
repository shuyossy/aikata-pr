import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { writeReportTool } from '../writeReport.js';

/**
 * writeReportToolのexecuteを型安全に呼び出すヘルパー
 * lockTimeoutMsを指定するとロック取得タイムアウトを短縮できる（テスト用）
 */
const executeWriteReport = (
  input: { content: string },
  resultFilePath: string,
  lockTimeoutMs?: number,
): Promise<{ success: boolean; charsWritten: number; message?: string }> => {
  const executeFn = writeReportTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  // RequestContextの型パラメータを明示的にunknownとして、制約の緩いコンストラクタシグネチャを利用する
  const entries: Array<readonly [string, unknown]> = [['resultFilePath', resultFilePath]];
  if (lockTimeoutMs !== undefined) {
    entries.push(['reportLockTimeoutMs', lockTimeoutMs]);
  }
  const requestContext = new RequestContext<unknown>(entries);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof writeReportTool.execute>>[1];
  return executeFn(input, context) as Promise<{
    success: boolean;
    charsWritten: number;
    message?: string;
  }>;
};

describe('writeReportTool', () => {
  let tmpDir: string;
  let filePath: string;

  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-report-write-'));
    filePath = path.join(tmpDir, 'report.md');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('コンテンツをファイルに書き込める', async () => {
    createTmpDir();
    const content = '# Pipeline Report\n\nAll jobs analyzed.';
    const result = await executeWriteReport({ content }, filePath);

    expect(result.success).toBe(true);
    expect(result.charsWritten).toBe(content.length);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('既存ファイルを上書きする', async () => {
    createTmpDir();
    fs.writeFileSync(filePath, 'old content', 'utf-8');

    const content = 'new content';
    const result = await executeWriteReport({ content }, filePath);

    expect(result.success).toBe(true);
    expect(result.charsWritten).toBe(content.length);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('ロック競合時に2回目の呼び出しがタイムアウトエラーになる', async () => {
    createTmpDir();
    // 先行ロックを手動で取得してロック競合をシミュレート
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath);
    try {
      // lockTimeoutMs=200で高速にタイムアウトさせる
      const result = await executeWriteReport({ content: 'x' }, filePath, 200);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/lock/i);
    } finally {
      fs.rmdirSync(lockPath);
    }
  });

  it('書き込み失敗時にsuccess=falseを返す', async () => {
    createTmpDir();
    // 存在しないディレクトリ配下のパスを指定して書き込み失敗を引き起こす
    // lockはファイル所在ディレクトリが存在しないとmkdirできないため、
    // 親ディレクトリは作成した上でファイルを書けない条件を作る（ディレクトリ→ファイルで競合させる）
    const badFilePath = path.join(tmpDir, 'collision');
    fs.mkdirSync(badFilePath); // ファイルパスと同名のディレクトリを事前作成
    const result = await executeWriteReport({ content: 'hello' }, badFilePath, 200);

    expect(result.success).toBe(false);
    expect(result.charsWritten).toBe(0);
    expect(result.message).toBeDefined();
  });
});
