import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { getReportTool } from '../getReport.js';

/**
 * getReportToolのexecuteを呼び出すヘルパー
 */
const executeGetReport = (resultFilePath: string): Promise<{ content: string }> => {
  const executeFn = getReportTool.execute;
  if (!executeFn) throw new Error('execute is not defined');
  const requestContext = new RequestContext([['resultFilePath', resultFilePath]]);
  const context = {
    requestContext,
  } as Parameters<NonNullable<typeof getReportTool.execute>>[1];
  return executeFn({}, context) as Promise<{ content: string }>;
};

describe('getReportTool', () => {
  let tmpDir: string;
  let filePath: string;

  const createTmpDir = (): void => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-report-get-'));
    filePath = path.join(tmpDir, 'report.md');
  };

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('レポートの内容を取得できる', async () => {
    createTmpDir();
    const content = '# Report\n\nSome analysis.';
    fs.writeFileSync(filePath, content, 'utf-8');

    const result = await executeGetReport(filePath);
    expect(result.content).toBe(content);
  });

  it('ファイル不在時は例外をスローする', async () => {
    createTmpDir();
    const missingPath = path.join(tmpDir, 'missing.md');

    await expect(executeGetReport(missingPath)).rejects.toThrow();
  });
});
