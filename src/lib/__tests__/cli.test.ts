import { describe, it, expect } from 'vitest';
import { parseCliOptions } from '../cli.js';

describe('parseCliOptions', () => {
  it('--user-idオプションをパースできる', () => {
    const result = parseCliOptions(['--user-id', 'test-user']);
    expect(result.userId).toBe('test-user');
  });

  it('--user-idが未指定の場合はUSER_ID環境変数にフォールバックする', () => {
    const result = parseCliOptions([], { USER_ID: 'env-user' });
    expect(result.userId).toBe('env-user');
  });

  it('CLIオプションが環境変数より優先される', () => {
    const result = parseCliOptions(['--user-id', 'cli-user'], { USER_ID: 'env-user' });
    expect(result.userId).toBe('cli-user');
  });

  it('--gitlab-tokenオプションをパースできる', () => {
    const result = parseCliOptions(['--gitlab-token', 'test-token']);
    expect(result.gitlabToken).toBe('test-token');
  });

  it('GITLAB_TOKEN環境変数からgitlabTokenを取得できる', () => {
    const result = parseCliOptions([], { GITLAB_TOKEN: 'env-token' });
    expect(result.gitlabToken).toBe('env-token');
  });

  it('--ai-model-nameオプションをパースできる', () => {
    const result = parseCliOptions(['--ai-model-name', 'openai/gpt-4']);
    expect(result.aiModelName).toBe('openai/gpt-4');
  });

  it('AI_MODEL_NAME環境変数からaiModelNameを取得できる', () => {
    const result = parseCliOptions([], { AI_MODEL_NAME: 'anthropic/claude-3' });
    expect(result.aiModelName).toBe('anthropic/claude-3');
  });

  it('aiModelNameのデフォルト値はopenai/o4-miniである', () => {
    const result = parseCliOptions([], {});
    expect(result.aiModelName).toBe('openai/o4-mini');
  });

  it('全てのサポートされたオプションをパースできる', () => {
    const result = parseCliOptions([
      '--user-id',
      'u1',
      '--project-id',
      'p1',
      '--mr-iid',
      '42',
      '--gitlab-token',
      'my-token',
      '--checklist',
      '/path/to/checklist.csv',
      '--review-settings',
      '/path/to/settings.json',
      '--skills',
      '/path/to/skills',
      '--ai-model-name',
      'openai/gpt-4',
      '--log-level',
      'debug',
      '--verbose-error',
    ]);
    expect(result.userId).toBe('u1');
    expect(result.projectId).toBe('p1');
    expect(result.mrIid).toBe('42');
    expect(result.gitlabToken).toBe('my-token');
    expect(result.checklist).toBe('/path/to/checklist.csv');
    expect(result.reviewSettings).toBe('/path/to/settings.json');
    expect(result.skills).toBe('/path/to/skills');
    expect(result.aiModelName).toBe('openai/gpt-4');
    expect(result.logLevel).toBe('debug');
    expect(result.verboseError).toBe(true);
  });

  it('未指定の場合はデフォルト値が使用される', () => {
    const result = parseCliOptions([], {});
    expect(result.logLevel).toBe('info');
    expect(result.verboseError).toBe(false);
  });

  it('環境変数からprojectId, mrIid, checklist, reviewSettings, skillsを取得できる', () => {
    const result = parseCliOptions([], {
      GITLAB_PROJECT_ID: 'env-project',
      GITLAB_MR_IID: '99',
      CHECKLIST_PATH: '/env/checklist.csv',
      REVIEW_SETTINGS_PATH: '/env/settings.json',
      SKILLS_PATH: '/env/skills',
    });
    expect(result.projectId).toBe('env-project');
    expect(result.mrIid).toBe('99');
    expect(result.checklist).toBe('/env/checklist.csv');
    expect(result.reviewSettings).toBe('/env/settings.json');
    expect(result.skills).toBe('/env/skills');
  });

  it('環境変数からlogLevelとverboseErrorを取得できる', () => {
    const result = parseCliOptions([], {
      LOG_LEVEL: 'warn',
      VERBOSE_ERROR: 'true',
    });
    expect(result.logLevel).toBe('warn');
    expect(result.verboseError).toBe(true);
  });

  it('VERBOSE_ERROR環境変数がtrue以外の場合はfalseになる', () => {
    const result = parseCliOptions([], { VERBOSE_ERROR: 'false' });
    expect(result.verboseError).toBe(false);
  });

  it('引数が空配列かつ環境変数が空の場合、オプション値はundefinedになる', () => {
    const result = parseCliOptions([], {});
    expect(result.userId).toBeUndefined();
    expect(result.projectId).toBeUndefined();
    expect(result.mrIid).toBeUndefined();
    expect(result.gitlabToken).toBeUndefined();
    expect(result.checklist).toBeUndefined();
    expect(result.reviewSettings).toBeUndefined();
    expect(result.skills).toBeUndefined();
  });

  it('不明なオプションは無視される', () => {
    const result = parseCliOptions(['--unknown', 'value', '--user-id', 'u1']);
    expect(result.userId).toBe('u1');
  });
});
