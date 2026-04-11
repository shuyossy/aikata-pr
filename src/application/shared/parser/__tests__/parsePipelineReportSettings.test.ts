import { describe, it, expect } from 'vitest';
import { parsePipelineReportSettings } from '../parsePipelineReportSettings.js';
import { PipelineReportSettingsParseError } from '../PipelineReportSettingsParseError.js';
import { PipelineReportSettings } from '../../../../domain/pipeline-report/pipelineReportSettings/PipelineReportSettings.js';

describe('parsePipelineReportSettings', () => {
  it('全フィールドを指定した JSON を正常にパースできる', () => {
    const json = JSON.stringify({
      jobReportFormat: '## {{jobName}} custom format',
      additionalInstructions: '失敗しているテストに特に注目すること',
      includeJobPatterns: ['^build:', '^test:'],
      excludeJobPatterns: ['^deploy:'],
    });

    const settings = parsePipelineReportSettings(json);

    expect(settings.jobReportFormat).toBe('## {{jobName}} custom format');
    expect(settings.additionalInstructions).toBe('失敗しているテストに特に注目すること');
    expect(settings.includeJobPatterns).toHaveLength(2);
    expect(settings.includeJobPatterns[0]).toBeInstanceOf(RegExp);
    expect(settings.includeJobPatterns[0].test('build:web')).toBe(true);
    expect(settings.includeJobPatterns[1].test('test:unit')).toBe(true);
    expect(settings.excludeJobPatterns).toHaveLength(1);
    expect(settings.excludeJobPatterns[0].test('deploy:prod')).toBe(true);
  });

  it('空 JSON の場合は全フィールドにデフォルト値が適用される', () => {
    const settings = parsePipelineReportSettings('{}');

    expect(settings.jobReportFormat).toBe(PipelineReportSettings.default().jobReportFormat);
    expect(settings.additionalInstructions).toBeNull();
    expect(settings.includeJobPatterns).toEqual([]);
    expect(settings.excludeJobPatterns).toEqual([]);
  });

  it('不正な JSON 文字列の場合は PipelineReportSettingsParseError を投げる', () => {
    expect(() => parsePipelineReportSettings('{invalid json')).toThrow(
      PipelineReportSettingsParseError,
    );
  });

  it('不正な RegExp パターンが含まれる場合は PipelineReportSettingsParseError を投げる', () => {
    const json = JSON.stringify({
      includeJobPatterns: ['[unclosed'],
    });

    expect(() => parsePipelineReportSettings(json)).toThrow(PipelineReportSettingsParseError);
  });

  it('includeJobPatterns が配列でない場合は PipelineReportSettingsParseError を投げる', () => {
    const json = JSON.stringify({
      includeJobPatterns: 'not-an-array',
    });

    expect(() => parsePipelineReportSettings(json)).toThrow(PipelineReportSettingsParseError);
  });
});
