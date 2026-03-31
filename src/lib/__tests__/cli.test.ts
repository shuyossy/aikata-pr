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

  it('--aikata-pr-gitlab-tokenオプションをパースできる', () => {
    const result = parseCliOptions(['--aikata-pr-gitlab-token', 'test-token']);
    expect(result.gitlabToken).toBe('test-token');
  });

  it('AIKATA_PR_GITLAB_TOKEN環境変数からgitlabTokenを取得できる', () => {
    const result = parseCliOptions([], { AIKATA_PR_GITLAB_TOKEN: 'env-token' });
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

  it('全てのサポートされたオプションをパースできる', () => {
    const result = parseCliOptions([
      '--user-id',
      'u1',
      '--project-id',
      'p1',
      '--mr-iid',
      '42',
      '--aikata-pr-gitlab-token',
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
      '--comment-language',
      'English',
      '--pretty-print',
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
    expect(result.commentLanguage).toBe('English');
    expect(result.prettyPrint).toBe(true);
  });

  it('未指定の場合はデフォルト値が使用される', () => {
    const result = parseCliOptions([], {});
    expect(result.logLevel).toBe('info');
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

  it('環境変数からlogLevelを取得できる', () => {
    const result = parseCliOptions([], {
      AIKATA_LOG_LEVEL: 'warn',
    });
    expect(result.logLevel).toBe('warn');
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
    expect(result.aiModelName).toBeUndefined();
  });

  it('不明なオプションは無視される', () => {
    const result = parseCliOptions(['--unknown', 'value', '--user-id', 'u1']);
    expect(result.userId).toBe('u1');
  });

  it('--comment-languageオプションをパースできる', () => {
    const result = parseCliOptions(['--comment-language', 'English']);
    expect(result.commentLanguage).toBe('English');
  });

  it('COMMENT_LANGUAGE環境変数からcommentLanguageを取得できる', () => {
    const result = parseCliOptions([], { COMMENT_LANGUAGE: 'English' });
    expect(result.commentLanguage).toBe('English');
  });

  it('--comment-languageがCOMMENT_LANGUAGE環境変数より優先される', () => {
    const result = parseCliOptions(['--comment-language', 'Korean'], {
      COMMENT_LANGUAGE: 'English',
    });
    expect(result.commentLanguage).toBe('Korean');
  });

  it('commentLanguageのデフォルト値はJapaneseである', () => {
    const result = parseCliOptions([], {});
    expect(result.commentLanguage).toBe('Japanese');
  });

  it('--pretty-printオプションをパースできる', () => {
    const result = parseCliOptions(['--pretty-print']);
    expect(result.prettyPrint).toBe(true);
  });

  it('--no-pretty-printオプションをパースできる', () => {
    const result = parseCliOptions(['--no-pretty-print']);
    expect(result.prettyPrint).toBe(false);
  });

  it('PRETTY_PRINT環境変数からprettyPrintを取得できる（true）', () => {
    const result = parseCliOptions([], { PRETTY_PRINT: 'true' });
    expect(result.prettyPrint).toBe(true);
  });

  it('PRETTY_PRINT環境変数がfalseの場合はprettyPrintがfalseになる', () => {
    const result = parseCliOptions([], { PRETTY_PRINT: 'false' });
    expect(result.prettyPrint).toBe(false);
  });

  it('--no-pretty-printがPRETTY_PRINT環境変数より優先される', () => {
    const result = parseCliOptions(['--no-pretty-print'], { PRETTY_PRINT: 'true' });
    expect(result.prettyPrint).toBe(false);
  });

  it('prettyPrintのデフォルト値はtrueである', () => {
    const result = parseCliOptions([], {});
    expect(result.prettyPrint).toBe(true);
  });
});
