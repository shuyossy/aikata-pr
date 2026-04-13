import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, defaultFeatures, type CliFeatureModule } from '../dispatch.js';

describe('cli dispatcher', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('プリントusageして非0終了: サブコマンド無し', async () => {
    const fakeFeatures: CliFeatureModule[] = [{ name: 'review', description: 'x', run: vi.fn() }];
    await expect(dispatch([], fakeFeatures)).rejects.toThrow('process.exit:1');
    const combined = errorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(combined).toContain('Usage: aikata-pr');
  });

  it('プリントusageして非0終了: 未知サブコマンド', async () => {
    const fakeFeatures: CliFeatureModule[] = [{ name: 'review', description: 'x', run: vi.fn() }];
    await expect(dispatch(['unknown'], fakeFeatures)).rejects.toThrow('process.exit:1');
    const combined = errorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(combined).toContain('Unknown command: unknown');
  });

  it('マッチした機能モジュールのrunを呼び出す', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const fakeFeatures: CliFeatureModule[] = [{ name: 'review', description: 'x', run: runMock }];
    await dispatch(['review', '--foo', 'bar'], fakeFeatures);
    expect(runMock).toHaveBeenCalledWith(['--foo', 'bar']);
  });

  it('pipeline-reportサブコマンドが登録されている', () => {
    expect(defaultFeatures.map((f) => f.name)).toContain('pipeline-report');
  });

  it('pipeline-reportサブコマンドを選択するとpipeline-report機能のrunが呼ばれる', async () => {
    const reviewRun = vi.fn().mockResolvedValue(undefined);
    const pipelineReportRun = vi.fn().mockResolvedValue(undefined);
    const fakeFeatures: CliFeatureModule[] = [
      { name: 'review', description: 'x', run: reviewRun },
      { name: 'pipeline-report', description: 'y', run: pipelineReportRun },
    ];
    await dispatch(['pipeline-report', '--user-id', 'alice'], fakeFeatures);
    expect(reviewRun).not.toHaveBeenCalled();
    expect(pipelineReportRun).toHaveBeenCalledWith(['--user-id', 'alice']);
  });

  it('defaultFeatures の pipeline-report 機能は name / description / run を持つ', () => {
    const feature = defaultFeatures.find((f) => f.name === 'pipeline-report');
    expect(feature).toBeDefined();
    expect(typeof feature!.description).toBe('string');
    expect(feature!.description.length).toBeGreaterThan(0);
    expect(typeof feature!.run).toBe('function');
  });

  it('defaultFeatures に server が含まれている', () => {
    expect(defaultFeatures.map((f) => f.name)).toContain('server');
  });

  it('defaultFeatures の server 機能は name / description / run を持つ', () => {
    const feature = defaultFeatures.find((f) => f.name === 'server');
    expect(feature).toBeDefined();
    expect(typeof feature!.description).toBe('string');
    expect(feature!.description.length).toBeGreaterThan(0);
    expect(typeof feature!.run).toBe('function');
  });

  it('serverサブコマンドを選択するとserver機能のrunが呼ばれる', async () => {
    const reviewRun = vi.fn().mockResolvedValue(undefined);
    const serverRun = vi.fn().mockResolvedValue(undefined);
    const fakeFeatures: CliFeatureModule[] = [
      { name: 'review', description: 'x', run: reviewRun },
      { name: 'server', description: 'y', run: serverRun },
    ];
    await dispatch(['server'], fakeFeatures);
    expect(reviewRun).not.toHaveBeenCalled();
    expect(serverRun).toHaveBeenCalledWith([]);
  });
});
