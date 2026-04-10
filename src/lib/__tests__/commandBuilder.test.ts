import { describe, it, expect } from 'vitest';
import {
  validateRequiredParams,
  buildApiReviewRequest,
  buildLocalReviewCommand,
} from '../commandBuilder.js';
import type { CliOptions } from '../cli.js';
import { Checklist } from '../../domain/checklist/index.js';
import { CheckItem } from '../../domain/checkItem/index.js';
import { Rating } from '../../domain/rating/index.js';
import { ReviewSettings } from '../../domain/reviewSettings/index.js';
import { QualityGate } from '../../domain/qualityGate/index.js';

// ヘルパー: テスト用のCliOptionsを生成
function createCliOptions(overrides?: Partial<CliOptions>): CliOptions {
  return {
    userId: 'test-user',
    projectId: 'project-1',
    mrIid: '42',
    gitlabToken: 'test-gitlab-token',
    checklist: '/path/to/checklist.csv',
    checklistColumns: undefined,
    checklistNoHeader: false,
    reviewSettings: undefined,
    skills: undefined,
    logLevel: 'info',
    aiModelName: 'openai/o4-mini',
    commentLanguage: 'Japanese',
    prettyPrint: true,
    aikataApiUrl: undefined,
    aikataJwt: undefined,
    ...overrides,
  };
}

// ヘルパー: テスト用のChecklistを生成
function createChecklist(): Checklist {
  return new Checklist([new CheckItem('コードの可読性'), new CheckItem('テストカバレッジ')]);
}

// ヘルパー: テスト用のReviewSettingsを生成
function createReviewSettings(
  overrides?: Partial<{
    additionalInstructions: string;
    concurrentReviewCount: number | null;
    commentFormat: string;
    ratings: Rating[];
    hiddenRatingLabels: string[];
    qualityGate: QualityGate;
  }>,
): ReviewSettings {
  return new ReviewSettings({
    additionalInstructions: overrides?.additionalInstructions ?? 'Be strict',
    concurrentReviewCount: overrides?.concurrentReviewCount ?? 2,
    commentFormat: overrides?.commentFormat ?? '## Review\n{comment}',
    ratings: overrides?.ratings ?? [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ],
    hiddenRatingLabels: overrides?.hiddenRatingLabels ?? ['A'],
    qualityGate: overrides?.qualityGate ?? new QualityGate([{ ratingLabel: 'C', threshold: 2 }]),
  });
}

describe('validateRequiredParams', () => {
  it('全必須パラメータ指定時にValidatedParamsが返ること', () => {
    const options = createCliOptions();
    const env = {
      AI_API_KEY: 'test-key',
      AI_API_ENDPOINT_URL: 'https://api.example.com',
    };

    const result = validateRequiredParams(options, env);

    expect(result.userId).toBe('test-user');
    expect(result.projectId).toBe('project-1');
    expect(result.mrIid).toBe('42');
    expect(result.gitlabToken).toBe('test-gitlab-token');
    expect(result.checklistPath).toBe('/path/to/checklist.csv');
    expect(result.aiModelName).toBe('openai/o4-mini');
    expect(result.aiApiKey).toBe('test-key');
    expect(result.aiApiEndpointUrl).toBe('https://api.example.com');
  });

  it('必須パラメータ不足時にエラーとなること', () => {
    const options = createCliOptions({ userId: undefined, projectId: undefined });
    const env = {
      AI_API_KEY: 'test-key',
      AI_API_ENDPOINT_URL: 'https://api.example.com',
    };

    expect(() => validateRequiredParams(options, env)).toThrow('Missing required parameters');
    expect(() => validateRequiredParams(options, env)).toThrow('--user-id or USER_ID');
    expect(() => validateRequiredParams(options, env)).toThrow('--project-id or GITLAB_PROJECT_ID');
  });

  it('APIモード時にAI関連パラメータが不要であること', () => {
    const options = createCliOptions({
      aikataApiUrl: 'https://api.aikata.com',
      aiModelName: undefined,
    });
    const env = {}; // AI_API_KEYやAI_API_ENDPOINT_URLなし

    const result = validateRequiredParams(options, env);

    expect(result.userId).toBe('test-user');
    expect(result.aiModelName).toBeUndefined();
    expect(result.aiApiKey).toBeUndefined();
    expect(result.aiApiEndpointUrl).toBeUndefined();
  });

  it('ローカルモード時にAI関連パラメータが必須であること', () => {
    const options = createCliOptions({ aiModelName: undefined });
    const env = {}; // AI_API_KEYなし

    expect(() => validateRequiredParams(options, env)).toThrow('--ai-model-name or AI_MODEL_NAME');
    expect(() => validateRequiredParams(options, env)).toThrow('AI_API_KEY');
    expect(() => validateRequiredParams(options, env)).toThrow('AI_API_ENDPOINT_URL');
  });
});

describe('buildApiReviewRequest', () => {
  it('全フィールド指定時に正しいReviewApiRequestが構築されること', () => {
    const validated = {
      userId: 'test-user',
      projectId: 'project-1',
      mrIid: '42',
      gitlabToken: 'test-gitlab-token',
      checklistPath: '/path/to/checklist.csv',
    };
    const checklist = createChecklist();
    const reviewSettings = createReviewSettings();
    const options = createCliOptions({
      skills: '/path/to/skills',
      commentLanguage: 'English',
    });

    const result = buildApiReviewRequest(validated, checklist, reviewSettings, options, 5);

    // 必須フィールド
    expect(result.gitlabToken).toBe('test-gitlab-token');
    expect(result.projectId).toBe('project-1');
    expect(result.mrIid).toBe('42');
    expect(result.checklist).toEqual(['コードの可読性', 'テストカバレッジ']);

    // reviewSettings
    expect(result.reviewSettings?.additionalInstructions).toBe('Be strict');
    expect(result.reviewSettings?.concurrentReviewCount).toBe(2);
    expect(result.reviewSettings?.commentFormat).toBe('## Review\n{comment}');
    expect(result.reviewSettings?.hiddenRatingLabels).toEqual(['A']);

    // options
    expect(result.options?.commentLanguage).toBe('English');
    expect(result.options?.skillsPaths).toEqual(['/path/to/skills']);
    expect(result.options?.treeMaxDepth).toBe(5);
  });

  it('reviewSettings.ratingsがReviewSettingsから正しく変換されること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
    };
    const checklist = createChecklist();
    const reviewSettings = createReviewSettings();
    const options = createCliOptions();

    const result = buildApiReviewRequest(validated, checklist, reviewSettings, options, undefined);

    expect(result.reviewSettings?.ratings).toEqual([
      { label: 'A', definition: '完全に満たしている' },
      { label: 'B', definition: '概ね満たしている' },
      { label: 'C', definition: '満たしていない' },
    ]);
  });

  it('reviewSettings.qualityGateが正しく変換されること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
    };
    const checklist = createChecklist();
    const reviewSettings = createReviewSettings();
    const options = createCliOptions();

    const result = buildApiReviewRequest(validated, checklist, reviewSettings, options, undefined);

    expect(result.reviewSettings?.qualityGate?.failureCriteria).toEqual([
      { ratingLabel: 'C', threshold: 2 },
    ]);
  });

  it('skills未指定時にskillsPathsが空配列になること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
    };
    const checklist = createChecklist();
    const reviewSettings = createReviewSettings();
    const options = createCliOptions({ skills: undefined });

    const result = buildApiReviewRequest(validated, checklist, reviewSettings, options, undefined);

    expect(result.options?.skillsPaths).toEqual([]);
  });

  it('skills指定時にskillsPathsが1要素配列になること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
    };
    const checklist = createChecklist();
    const reviewSettings = createReviewSettings();
    const options = createCliOptions({ skills: '/my/skills.yaml' });

    const result = buildApiReviewRequest(validated, checklist, reviewSettings, options, undefined);

    expect(result.options?.skillsPaths).toEqual(['/my/skills.yaml']);
  });
});

describe('buildLocalReviewCommand', () => {
  it('全フィールド指定時に正しいReviewExecutionCommandが構築されること', () => {
    const validated = {
      userId: 'test-user',
      projectId: 'project-1',
      mrIid: '42',
      gitlabToken: 'test-gitlab-token',
      checklistPath: '/path/to/checklist.csv',
      aiApiKey: 'test-api-key',
      aiApiEndpointUrl: 'https://api.example.com',
      aiModelName: 'openai/o4-mini',
    };
    const checklist = createChecklist();
    const reviewSettings = createReviewSettings();
    const options = createCliOptions({
      skills: '/path/to/skills',
      commentLanguage: 'English',
    });

    const result = buildLocalReviewCommand(
      validated,
      checklist,
      reviewSettings,
      options,
      '/project/dir',
      5,
      50000,
      'high',
    );

    expect(result.userId).toBe('test-user');
    expect(result.projectId).toBe('project-1');
    expect(result.mrIid).toBe('42');
    expect(result.gitlabToken).toBe('test-gitlab-token');
    expect(result.checklist).toBe(checklist);
    expect(result.reviewSettings).toBe(reviewSettings);
    expect(result.skillsPaths).toEqual(['/path/to/skills']);
    expect(result.projectDir).toBe('/project/dir');
    expect(result.aiApiKey).toBe('test-api-key');
    expect(result.aiApiEndpointUrl).toBe('https://api.example.com');
    expect(result.aiModelName).toBe('openai/o4-mini');
    expect(result.treeMaxDepth).toBe(5);
    expect(result.commentLanguage).toBe('English');
    expect(result.openaiReasoningEffort).toBe('high');
    expect(result.maxContextLength).toBe(50000);
  });

  it('treeMaxDepth未指定時にundefinedとなること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
      aiApiKey: 'k',
      aiApiEndpointUrl: 'https://e',
      aiModelName: 'm',
    };

    const result = buildLocalReviewCommand(
      validated,
      createChecklist(),
      createReviewSettings(),
      createCliOptions(),
      '/dir',
      undefined,
      undefined,
      undefined,
    );

    expect(result.treeMaxDepth).toBeUndefined();
  });

  it('maxContextLength未指定時にundefinedとなること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
      aiApiKey: 'k',
      aiApiEndpointUrl: 'https://e',
      aiModelName: 'm',
    };

    const result = buildLocalReviewCommand(
      validated,
      createChecklist(),
      createReviewSettings(),
      createCliOptions(),
      '/dir',
      undefined,
      undefined,
      undefined,
    );

    expect(result.maxContextLength).toBeUndefined();
  });

  it('skills未指定時にskillsPathsが空配列となること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
      aiApiKey: 'k',
      aiApiEndpointUrl: 'https://e',
      aiModelName: 'm',
    };

    const result = buildLocalReviewCommand(
      validated,
      createChecklist(),
      createReviewSettings(),
      createCliOptions({ skills: undefined }),
      '/dir',
      undefined,
      undefined,
      undefined,
    );

    expect(result.skillsPaths).toEqual([]);
  });

  it('openaiReasoningEffort未指定時にundefinedとなること', () => {
    const validated = {
      userId: 'u',
      projectId: 'p',
      mrIid: '1',
      gitlabToken: 't',
      checklistPath: '/c',
      aiApiKey: 'k',
      aiApiEndpointUrl: 'https://e',
      aiModelName: 'm',
    };

    const result = buildLocalReviewCommand(
      validated,
      createChecklist(),
      createReviewSettings(),
      createCliOptions(),
      '/dir',
      undefined,
      undefined,
      undefined,
    );

    expect(result.openaiReasoningEffort).toBeUndefined();
  });
});
