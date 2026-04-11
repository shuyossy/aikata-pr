import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { patchReportTool } from '../patchReport.js';

type PatchResult = {
  success: boolean;
  matchCount: number;
  error?: 'ambiguous' | 'not-found' | 'fs-error';
  message?: string;
};

/**
 * patchReportToolのexecuteを型安全に呼び出すヘルパー
 */
const executePatch = (
  input: { oldString: string; newString: string; replaceAll: boolean },
  resultFilePath: string,
  lockTimeoutMs?: number,
): Promise<PatchResult> => {
  const executeFn = patchReportTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const entries: Array<[string, unknown]> = [['resultFilePath', resultFilePath]];
  if (lockTimeoutMs !== undefined) {
    entries.push(['reportLockTimeoutMs', lockTimeoutMs]);
  }
  const requestContext = new RequestContext(entries);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof patchReportTool.execute>>[1];
  return executeFn(input, context) as Promise<PatchResult>;
};

describe('patchReportTool', () => {
  let tmpDir: string;
  let filePath: string;

  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-report-patch-'));
    filePath = path.join(tmpDir, 'report.md');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('単一マッチで置換できる', async () => {
    createTmpDir();
    fs.writeFileSync(filePath, 'hello world', 'utf-8');

    const result = await executePatch(
      { oldString: 'world', newString: 'pipeline', replaceAll: false },
      filePath,
    );

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello pipeline');
  });

  it('見つからない場合はerror=not-foundを返す', async () => {
    createTmpDir();
    fs.writeFileSync(filePath, 'hello world', 'utf-8');

    const result = await executePatch(
      { oldString: 'missing', newString: 'pipeline', replaceAll: false },
      filePath,
    );

    expect(result.success).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.error).toBe('not-found');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('複数マッチでreplaceAll=falseならerror=ambiguousを返す', async () => {
    createTmpDir();
    fs.writeFileSync(filePath, 'foo bar foo bar foo', 'utf-8');

    const result = await executePatch(
      { oldString: 'foo', newString: 'baz', replaceAll: false },
      filePath,
    );

    expect(result.success).toBe(false);
    expect(result.matchCount).toBe(3);
    expect(result.error).toBe('ambiguous');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('foo bar foo bar foo');
  });

  it('複数マッチでreplaceAll=trueなら全置換する', async () => {
    createTmpDir();
    fs.writeFileSync(filePath, 'foo bar foo bar foo', 'utf-8');

    const result = await executePatch(
      { oldString: 'foo', newString: 'baz', replaceAll: true },
      filePath,
    );

    expect(result.success).toBe(true);
    expect(result.matchCount).toBe(3);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('baz bar baz bar baz');
  });

  it('ファイル読み込み失敗時にerror=fs-errorを返す', async () => {
    createTmpDir();
    // ファイルを作成せずに呼び出し
    const missingPath = path.join(tmpDir, 'missing.md');

    const result = await executePatch(
      { oldString: 'x', newString: 'y', replaceAll: false },
      missingPath,
      200,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('fs-error');
  });
});
