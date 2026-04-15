import { describe, it, expect } from 'vitest';
import { parsePipelineReportSettings } from '../parsePipelineReportSettings.js';
import { PipelineReportSettingsParseError } from '../PipelineReportSettingsParseError.js';
import { PipelineReportSettings } from '../../../../domain/pipeline-report/pipelineReportSettings/PipelineReportSettings.js';

describe('parsePipelineReportSettings', () => {
  it('全フィールドを指定した JSON を正常にパースできる', () => {
    const json = JSON.stringify({
      jobReportFormat: '## {{jobName}} custom format',
      analysisInstructions: '失敗しているテストに特に注目すること',
      includeJobPatterns: ['^build:', '^test:'],
      excludeJobPatterns: ['^deploy:'],
    });

    const settings = parsePipelineReportSettings(json);

    expect(settings.jobReportFormat).toBe('## {{jobName}} custom format');
    expect(settings.analysisInstructions).toBe('失敗しているテストに特に注目すること');
    expect(settings.includeJobPatterns).toHaveLength(2);
    expect(settings.includeJobPatterns[0]).toBeInstanceOf(RegExp);
    expect(settings.includeJobPatterns[0].test('build:web')).toBe(true);
    expect(settings.includeJobPatterns[1].test('test:unit')).toBe(true);
    expect(settings.excludeJobPatterns).toHaveLength(1);
    expect(settings.excludeJobPatterns[0].test('deploy:prod')).toBe(true);
  });

  it('reportRefinementInstructions を指定した場合に正しくパースされる', () => {
    const json = JSON.stringify({
      reportRefinementInstructions: '問題なしのジョブは非表示にする',
    });

    const settings = parsePipelineReportSettings(json);

    expect(settings.reportRefinementInstructions).toBe('問題なしのジョブは非表示にする');
  });

  it('空 JSON の場合は全フィールドにデフォルト値が適用される', () => {
    const settings = parsePipelineReportSettings('{}');

    expect(settings.jobReportFormat).toBe(PipelineReportSettings.default().jobReportFormat);
    expect(settings.analysisInstructions).toBeNull();
    expect(settings.reportRefinementInstructions).toBeNull();
    expect(settings.includeJobPatterns).toEqual([]);
    expect(settings.excludeJobPatterns).toEqual([]);
  });

  it('不正な JSON 文字列の場合は PipelineReportSettingsParseError を投げ、not valid JSON を示すメッセージを返す', () => {
    expect(() => parsePipelineReportSettings('{invalid json')).toThrow(
      PipelineReportSettingsParseError,
    );
    expect(() => parsePipelineReportSettings('{invalid json')).toThrow(/not valid JSON/);
  });

  it('不正な RegExp パターンが含まれる場合は PipelineReportSettingsParseError を投げ、invalid RegExp を示すメッセージを返す', () => {
    const json = JSON.stringify({
      includeJobPatterns: ['[unclosed'],
    });

    expect(() => parsePipelineReportSettings(json)).toThrow(PipelineReportSettingsParseError);
    expect(() => parsePipelineReportSettings(json)).toThrow(/invalid RegExp/);
  });

  it('includeJobPatterns が配列でない場合は PipelineReportSettingsParseError を投げ、invalid shape を示すメッセージを返す', () => {
    const json = JSON.stringify({
      includeJobPatterns: 'not-an-array',
    });

    expect(() => parsePipelineReportSettings(json)).toThrow(PipelineReportSettingsParseError);
    expect(() => parsePipelineReportSettings(json)).toThrow(/invalid shape/);
  });

  it('未知のキーが含まれる場合は PipelineReportSettingsParseError を投げ、invalid shape を示すメッセージを返す', () => {
    // タイポ（jobReportFromat）などの未知キーを strict スキーマで拒否できることを確認する
    const json = JSON.stringify({
      jobReportFromat: '## typo format',
    });

    expect(() => parsePipelineReportSettings(json)).toThrow(PipelineReportSettingsParseError);
    expect(() => parsePipelineReportSettings(json)).toThrow(/invalid shape/);
  });
});
