import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, type CliFeatureModule } from '../dispatch.js';

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
});
