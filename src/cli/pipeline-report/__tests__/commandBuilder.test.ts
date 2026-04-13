import { describe, it, expect } from 'vitest';
import {
  validateRequiredParams,
  buildPipelineReportCommand,
  buildPipelineReportApiRequest,
  isLocalMode,
} from '../commandBuilder.js';
import type { PipelineReportCliOptions } from '../parsePipelineReportArgs.js';
import { PipelineReportSettings } from '../../../domain/pipeline-report/pipelineReportSettings/index.js';

// ヘルパー: テスト用のPipelineReportCliOptionsを生成
function createCliOptions(overrides?: Partial<PipelineReportCliOptions>): PipelineReportCliOptions {
  return {
    userId: 'alice',
    projectId: '123',
    pipelineId: '456',
    selfJobId: undefined,
    pipelineReportSettings: undefined,
    skills: undefined,
    gitlabToken: 'gitlab-token',
    aiModelName: 'openai/o4-mini',
    logLevel: 'info',
    commentLanguage: 'Japanese',
    prettyPrint: true,
    aikataApiUrl: undefined,
    aikataJwt: undefined,
    resultFile: './aikata-pipeline-report.md',
    maxCompletenessRetries: 3,
    treeMaxDepth: undefined,
    ...overrides,
  };
}

describe('isLocalMode', () => {
  it('AI_API_KEY/AI_API_ENDPOINT_URL/aiModelName全指定時にtrueを返す', () => {
    const options = createCliOptions();
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    expect(isLocalMode(options, env)).toBe(true);
  });

  it('AI_API_KEYが無い場合にfalseを返す', () => {
    const options = createCliOptions();
    const env = { AI_API_ENDPOINT_URL: 'https://x' };
    expect(isLocalMode(options, env)).toBe(false);
  });

  it('AI_API_ENDPOINT_URLが無い場合にfalseを返す', () => {
    const options = createCliOptions();
    const env = { AI_API_KEY: 'k' };
    expect(isLocalMode(options, env)).toBe(false);
  });
});

describe('validateRequiredParams', () => {
  it('ローカルモード用の必須項目が全て揃っていれば成功する', () => {
    const options = createCliOptions();
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    const result = validateRequiredParams(options, env);
    expect(result.userId).toBe('alice');
    expect(result.projectId).toBe(123);
    expect(result.pipelineId).toBe(456);
    expect(result.selfJobId).toBeNull();
    expect(result.gitlabToken).toBe('gitlab-token');
    expect(result.aiModelName).toBe('openai/o4-mini');
  });

  it('selfJobIdが指定されている場合は数値に変換される', () => {
    const options = createCliOptions({ selfJobId: '789' });
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    const result = validateRequiredParams(options, env);
    expect(result.selfJobId).toBe(789);
  });

  it('APIモード用の必須項目が揃っていれば成功する', () => {
    const options = createCliOptions({ aikataApiUrl: 'https://api.example.com' });
    const env = {};
    const result = validateRequiredParams(options, env);
    expect(result.aikataApiUrl).toBe('https://api.example.com');
  });

  it('userId欠落でエラーになる', () => {
    const options = createCliOptions({ userId: undefined });
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    expect(() => validateRequiredParams(options, env)).toThrow(/--user-id or USER_ID/);
  });

  it('projectId欠落でエラーになる', () => {
    const options = createCliOptions({ projectId: undefined });
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    expect(() => validateRequiredParams(options, env)).toThrow(/--project-id/);
  });

  it('pipelineId欠落でエラーになる', () => {
    const options = createCliOptions({ pipelineId: undefined });
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    expect(() => validateRequiredParams(options, env)).toThrow(/--pipeline-id/);
  });

  it('APIモードでaikata-api-url欠落時にエラーになる', () => {
    const options = createCliOptions({ aikataApiUrl: undefined });
    const env = {};
    expect(() => validateRequiredParams(options, env)).toThrow(/--aikata-api-url/);
  });

  it('ローカルモードでAI_API_KEY欠落時にエラーになる', () => {
    const options = createCliOptions();
    // AI_API_KEY未指定 → isLocalModeがfalseになるため代わりにaikataApiUrlが必須に
    // 今回はローカルモード相当のケースにするため AI_API_ENDPOINT_URL のみ与え、
    // aiModelName も真になっている状態で再検討: isLocalMode は AI_API_KEY も見るのでfalse
    // したがってこのケースは自然にAPIモード扱いとなる。
    // 改めて: ローカルモードでは AI_API_KEY と AI_API_ENDPOINT_URL が両方無ければダメ。
    // 逆に、AI_API_KEY のみ欠落させるケースではAPIモードに落ちる → aikataApiUrl 必須エラーになる
    const env = { AI_API_ENDPOINT_URL: 'https://x' };
    expect(() => validateRequiredParams(options, env)).toThrow(/--aikata-api-url/);
  });

  it('projectIdが数値に変換できない場合にエラーになる', () => {
    const options = createCliOptions({ projectId: 'abc' });
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    expect(() => validateRequiredParams(options, env)).toThrow(/Invalid project-id/);
  });

  it('pipelineIdが0以下の場合にエラーになる', () => {
    const options = createCliOptions({ pipelineId: '0' });
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    expect(() => validateRequiredParams(options, env)).toThrow(/Invalid pipeline-id/);
  });
});

describe('buildPipelineReportCommand', () => {
  it('ローカルモード用のPipelineAnalyzeCommandを組み立てる', () => {
    const options = createCliOptions({
      skills: '/skills',
      commentLanguage: 'English',
      treeMaxDepth: 3,
      maxCompletenessRetries: 5,
    });
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    const validated = validateRequiredParams(options, env);
    const settings = PipelineReportSettings.default();
    const onProgress = (): void => {};

    const command = buildPipelineReportCommand(options, validated, {
      settings,
      projectDir: '/tmp/project',
      maxContextLength: 100000,
      openaiReasoningEffort: 'medium',
      onProgress,
    });

    expect(command.userId).toBe('alice');
    expect(command.projectId).toBe(123);
    expect(command.pipelineId).toBe(456);
    expect(command.selfJobId).toBeNull();
    expect(command.settings).toBe(settings);
    expect(command.projectDir).toBe('/tmp/project');
    expect(command.commentLanguage).toBe('English');
    expect(command.skillsPaths).toEqual(['/skills']);
    expect(command.aiConfig.apiKey).toBe('k');
    expect(command.aiConfig.endpointUrl).toBe('https://x');
    expect(command.aiConfig.modelName).toBe('openai/o4-mini');
    expect(command.aiConfig.reasoningEffort).toBe('medium');
    expect(command.maxContextLength).toBe(100000);
    expect(command.treeMaxDepth).toBe(3);
    expect(command.options.maxCompletenessRetries).toBe(5);
    expect(command.onProgress).toBe(onProgress);
  });

  it('skills未指定時は空配列になる', () => {
    const options = createCliOptions();
    const env = { AI_API_KEY: 'k', AI_API_ENDPOINT_URL: 'https://x' };
    const validated = validateRequiredParams(options, env);
    const settings = PipelineReportSettings.default();

    const command = buildPipelineReportCommand(options, validated, {
      settings,
      projectDir: '/tmp/project',
      maxContextLength: null,
      openaiReasoningEffort: null,
      onProgress: () => {},
    });

    expect(command.skillsPaths).toEqual([]);
    expect(command.maxContextLength).toBeNull();
    expect(command.aiConfig.reasoningEffort).toBeNull();
  });
});

describe('buildPipelineReportApiRequest', () => {
  it('APIモード用のPipelineReportApiRequestを組み立てる', () => {
    const options = createCliOptions({
      aikataApiUrl: 'https://api.example.com',
      skills: '/skills',
      treeMaxDepth: 2,
    });
    const env = {};
    const validated = validateRequiredParams(options, env);

    // includeJobPatterns/excludeJobPatternsを持つ設定
    const settings = PipelineReportSettings.of({
      jobReportFormat: 'custom-format',
      additionalInstructions: 'extra',
      includeJobPatterns: [/^build-.*/, /^test-.*/],
      excludeJobPatterns: [/^skip-.*/],
    });

    const request = buildPipelineReportApiRequest(options, validated, settings);

    expect(request.userId).toBe('alice');
    expect(request.gitlabToken).toBe('gitlab-token');
    expect(request.projectId).toBe(123);
    expect(request.pipelineId).toBe(456);
    expect(request.selfJobId).toBeNull();
    expect(request.settings.jobReportFormat).toBe('custom-format');
    expect(request.settings.additionalInstructions).toBe('extra');
    expect(request.settings.includeJobPatterns).toEqual(['^build-.*', '^test-.*']);
    expect(request.settings.excludeJobPatterns).toEqual(['^skip-.*']);
    expect(request.commentLanguage).toBe('Japanese');
    expect(request.maxCompletenessRetries).toBe(3);
    expect(request.skillsRelPaths).toEqual(['/skills']);
    expect(request.treeMaxDepth).toBe(2);
  });

  it('skills未指定時は空配列になる', () => {
    const options = createCliOptions({ aikataApiUrl: 'https://api.example.com' });
    const env = {};
    const validated = validateRequiredParams(options, env);
    const settings = PipelineReportSettings.default();

    const request = buildPipelineReportApiRequest(options, validated, settings);

    expect(request.skillsRelPaths).toEqual([]);
    expect(request.settings.includeJobPatterns).toEqual([]);
    expect(request.settings.excludeJobPatterns).toEqual([]);
  });
});
