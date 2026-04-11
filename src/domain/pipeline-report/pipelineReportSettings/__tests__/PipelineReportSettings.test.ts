import { describe, it, expect } from 'vitest';
import { Job, type JobParams } from '../../job/Job.js';
import { PipelineReportSettings } from '../PipelineReportSettings.js';

function makeJob(id: number, name: string): Job {
  const params: JobParams = {
    id,
    name,
    stage: 'build',
    status: 'success',
    startedAt: new Date('2026-04-11T00:00:00Z'),
    finishedAt: new Date('2026-04-11T00:01:00Z'),
    duration: 60,
    webUrl: `https://gitlab.example.com/jobs/${id}`,
    failureReason: null,
    hasArtifacts: false,
    artifactsSize: 0,
  };
  return Job.of(params);
}

function makeSettings(
  overrides: Partial<{
    jobReportFormat: string;
    additionalInstructions: string | null;
    includeJobPatterns: RegExp[];
    excludeJobPatterns: RegExp[];
  }> = {},
): PipelineReportSettings {
  return new PipelineReportSettings(
    overrides.jobReportFormat ?? '## {{jobName}}',
    overrides.additionalInstructions ?? null,
    overrides.includeJobPatterns ?? [],
    overrides.excludeJobPatterns ?? [],
  );
}

describe('PipelineReportSettings.filterJobs', () => {
  const build = makeJob(1, 'build');
  const test = makeJob(2, 'test');
  const lint = makeJob(3, 'lint');
  const self = makeJob(99, 'aikata-pipeline-report');
  const allJobs = [build, test, lint, self];

  it('selfJobIdに一致するジョブだけを除外する', () => {
    const settings = makeSettings();
    const result = settings.filterJobs(allJobs, 99);

    expect(result.map((j) => j.id)).toEqual([1, 2, 3]);
  });

  it('selfJobIdがnullでパターンも空なら全てのジョブが通る', () => {
    const settings = makeSettings();
    const result = settings.filterJobs(allJobs, null);

    expect(result).toHaveLength(4);
  });

  it('includeJobPatternsが指定されるとマッチするジョブのみ通る', () => {
    const settings = makeSettings({ includeJobPatterns: [/^test$/, /^lint$/] });
    const result = settings.filterJobs(allJobs, null);

    expect(result.map((j) => j.name)).toEqual(['test', 'lint']);
  });

  it('excludeJobPatternsが指定されるとマッチするジョブが除外される', () => {
    const settings = makeSettings({ excludeJobPatterns: [/^lint$/] });
    const result = settings.filterJobs(allJobs, null);

    expect(result.map((j) => j.name)).toEqual(['build', 'test', 'aikata-pipeline-report']);
  });

  it('self + include + excludeを組み合わせる', () => {
    const settings = makeSettings({
      includeJobPatterns: [/^(build|test|lint|aikata.*)$/],
      excludeJobPatterns: [/^lint$/],
    });
    const result = settings.filterJobs(allJobs, 99);

    expect(result.map((j) => j.name)).toEqual(['build', 'test']);
  });

  it('includeJobPatternsにマッチしないジョブは除外される', () => {
    const settings = makeSettings({ includeJobPatterns: [/^deploy/] });
    const result = settings.filterJobs(allJobs, null);

    expect(result).toEqual([]);
  });
});
