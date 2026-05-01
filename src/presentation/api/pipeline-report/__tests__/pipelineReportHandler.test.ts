import { describe, it, expect } from 'vitest';
import {
  pipelineReportRequestSchema,
  buildPipelineReportSettings,
} from '../pipelineReportHandler.js';
import { PipelineReportSettings } from '../../../../domain/pipeline-report/pipelineReportSettings/index.js';

/**
 * テスト用に有効な最小リクエストボディを生成するヘルパー
 */
function createValidRequestBody(): Record<string, unknown> {
  return {
    userId: 'alice',
    gitlabToken: 'token-xyz',
    gitlabApiUrl: 'https://gitlab.example.com/api/v4',
    projectId: 42,
    pipelineId: 2001,
    selfJobId: 3001,
    settings: {},
    commentLanguage: 'Japanese',
    maxCompletenessRetries: 3,
    skillsRelPaths: [],
  };
}

describe('pipelineReportRequestSchema', () => {
  it('必須フィールドが揃っている最小リクエストがバリデーションを通ること', () => {
    const input = createValidRequestBody();
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('selfJobId が null のリクエストがバリデーションを通ること', () => {
    const input = { ...createValidRequestBody(), selfJobId: null };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('settings.includeJobPatterns / excludeJobPatterns を持つリクエストが通ること', () => {
    const input = {
      ...createValidRequestBody(),
      settings: {
        jobReportFormat: '### <jobName>',
        analysisInstructions: 'focus on security jobs',
        reportRefinementInstructions: 'hide passing jobs',
        includeJobPatterns: ['^test:', '^build'],
        excludeJobPatterns: ['\\.dev$'],
      },
    };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('userId が未指定の場合にバリデーションエラーとなること', () => {
    const { userId: _userId, ...rest } = createValidRequestBody();
    void _userId;
    const result = pipelineReportRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('gitlabApiUrl が未指定の場合にバリデーションエラーとなること', () => {
    const { gitlabApiUrl: _gitlabApiUrl, ...rest } = createValidRequestBody();
    void _gitlabApiUrl;
    const result = pipelineReportRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('gitlabApiUrl がURL形式でない場合にバリデーションエラーとなること', () => {
    const input = { ...createValidRequestBody(), gitlabApiUrl: 'not-a-url' };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('gitlabToken が空文字の場合にバリデーションエラーとなること', () => {
    const input = { ...createValidRequestBody(), gitlabToken: '' };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('projectId が 0 以下の場合にバリデーションエラーとなること', () => {
    const input = { ...createValidRequestBody(), projectId: 0 };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('projectId が文字列の場合にバリデーションエラーとなること', () => {
    const input = { ...createValidRequestBody(), projectId: '42' };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('pipelineId が負数の場合にバリデーションエラーとなること', () => {
    const input = { ...createValidRequestBody(), pipelineId: -1 };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('maxCompletenessRetries が 0 の場合にバリデーションを通ること', () => {
    const input = { ...createValidRequestBody(), maxCompletenessRetries: 0 };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('skillsRelPaths が配列でない場合にバリデーションエラーとなること', () => {
    const input = { ...createValidRequestBody(), skillsRelPaths: 'not-array' };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('commentLanguage が空文字の場合にバリデーションエラーとなること', () => {
    const input = { ...createValidRequestBody(), commentLanguage: '' };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('treeMaxDepth が省略されたリクエストが通ること', () => {
    const input = createValidRequestBody();
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.treeMaxDepth).toBeUndefined();
    }
  });

  it('settings が省略されたリクエストが通ること', () => {
    const input = { ...createValidRequestBody() };
    delete (input as Record<string, unknown>)['settings'];
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('skipCompletenessCheck=true のリクエストが通ること', () => {
    const input = { ...createValidRequestBody(), skipCompletenessCheck: true };
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skipCompletenessCheck).toBe(true);
    }
  });

  it('skipCompletenessCheck が省略された場合にデフォルト false となること', () => {
    const input = createValidRequestBody();
    const result = pipelineReportRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skipCompletenessCheck).toBe(false);
    }
  });
});

describe('buildPipelineReportSettings', () => {
  it('settings が undefined の場合にデフォルト設定が返ること', () => {
    const settings = buildPipelineReportSettings(undefined);
    const defaults = PipelineReportSettings.default();
    expect(settings.jobReportFormat).toBe(defaults.jobReportFormat);
    expect(settings.analysisInstructions).toBe(defaults.analysisInstructions);
    expect(settings.reportRefinementInstructions).toBe(defaults.reportRefinementInstructions);
    expect(settings.includeJobPatterns).toEqual([]);
    expect(settings.excludeJobPatterns).toEqual([]);
  });

  it('jobReportFormat がカスタム指定された場合に反映されること', () => {
    const settings = buildPipelineReportSettings({
      jobReportFormat: '### custom <jobName>',
    });
    expect(settings.jobReportFormat).toBe('### custom <jobName>');
  });

  it('analysisInstructions を保持すること', () => {
    const settings = buildPipelineReportSettings({
      analysisInstructions: 'be strict',
    });
    expect(settings.analysisInstructions).toBe('be strict');
  });

  it('reportRefinementInstructions を保持すること', () => {
    const settings = buildPipelineReportSettings({
      reportRefinementInstructions: 'hide passing jobs',
    });
    expect(settings.reportRefinementInstructions).toBe('hide passing jobs');
  });

  it('includeJobPatterns / excludeJobPatterns が RegExp にコンパイルされること', () => {
    const settings = buildPipelineReportSettings({
      includeJobPatterns: ['^test:', '^build'],
      excludeJobPatterns: ['\\.dev$'],
    });
    expect(settings.includeJobPatterns.map((r) => r.source)).toEqual(['^test:', '^build']);
    expect(settings.excludeJobPatterns.map((r) => r.source)).toEqual(['\\.dev$']);
  });

  it('includeJobPatterns に不正な RegExp が含まれる場合にエラーが投げられること', () => {
    expect(() =>
      buildPipelineReportSettings({
        includeJobPatterns: ['[unclosed'],
      }),
    ).toThrow(/Invalid RegExp in includeJobPatterns/);
  });

  it('excludeJobPatterns に不正な RegExp が含まれる場合にエラーが投げられること', () => {
    expect(() =>
      buildPipelineReportSettings({
        excludeJobPatterns: ['(unclosed'],
      }),
    ).toThrow(/Invalid RegExp in excludeJobPatterns/);
  });

  it('空配列の includeJobPatterns がそのまま空配列となること', () => {
    const settings = buildPipelineReportSettings({
      includeJobPatterns: [],
    });
    expect(settings.includeJobPatterns).toEqual([]);
  });
});
