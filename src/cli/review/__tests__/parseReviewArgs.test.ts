import { describe, it, expect } from 'vitest';
import { parseCliOptions, buildChecklistParseOptions } from '../parseReviewArgs.js';

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
      '--checklist-columns',
      '1,3',
      '--checklist-no-header',
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
    expect(result.checklistColumns).toBe('1,3');
    expect(result.checklistNoHeader).toBe(true);
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

  it('--checklist-columnsオプションをパースできる', () => {
    const result = parseCliOptions(['--checklist-columns', '2,3']);
    expect(result.checklistColumns).toBe('2,3');
  });

  it('CHECKLIST_COLUMNS環境変数からchecklistColumnsを取得できる', () => {
    const result = parseCliOptions([], { CHECKLIST_COLUMNS: '1,2' });
    expect(result.checklistColumns).toBe('1,2');
  });

  it('--checklist-columnsがCHECKLIST_COLUMNS環境変数より優先される', () => {
    const result = parseCliOptions(['--checklist-columns', '3'], {
      CHECKLIST_COLUMNS: '1,2',
    });
    expect(result.checklistColumns).toBe('3');
  });

  it('checklistColumnsの未指定時はundefinedである', () => {
    const result = parseCliOptions([], {});
    expect(result.checklistColumns).toBeUndefined();
  });

  it('--checklist-no-headerオプションをパースできる', () => {
    const result = parseCliOptions(['--checklist-no-header']);
    expect(result.checklistNoHeader).toBe(true);
  });

  it('CHECKLIST_NO_HEADER環境変数からchecklistNoHeaderを取得できる（true）', () => {
    const result = parseCliOptions([], { CHECKLIST_NO_HEADER: 'true' });
    expect(result.checklistNoHeader).toBe(true);
  });

  it('CHECKLIST_NO_HEADER環境変数がfalseの場合はchecklistNoHeaderがfalseになる', () => {
    const result = parseCliOptions([], { CHECKLIST_NO_HEADER: 'false' });
    expect(result.checklistNoHeader).toBe(false);
  });

  it('--checklist-no-headerがCHECKLIST_NO_HEADER環境変数より優先される', () => {
    const result = parseCliOptions(['--checklist-no-header'], {
      CHECKLIST_NO_HEADER: 'false',
    });
    expect(result.checklistNoHeader).toBe(true);
  });

  it('checklistNoHeaderのデフォルト値はfalseである', () => {
    const result = parseCliOptions([], {});
    expect(result.checklistNoHeader).toBe(false);
  });

  it('--aikata-api-urlオプションをパースできる', () => {
    const result = parseCliOptions(['--aikata-api-url', 'https://api.example.com']);
    expect(result.aikataApiUrl).toBe('https://api.example.com');
  });

  it('AIKATA_API_URL環境変数からaikataApiUrlを取得できる', () => {
    const result = parseCliOptions([], { AIKATA_API_URL: 'https://env-api.example.com' });
    expect(result.aikataApiUrl).toBe('https://env-api.example.com');
  });

  it('--aikata-api-urlがAIKATA_API_URL環境変数より優先される', () => {
    const result = parseCliOptions(['--aikata-api-url', 'https://cli-api.example.com'], {
      AIKATA_API_URL: 'https://env-api.example.com',
    });
    expect(result.aikataApiUrl).toBe('https://cli-api.example.com');
  });

  it('aikataApiUrlの未指定時はundefinedである', () => {
    const result = parseCliOptions([], {});
    expect(result.aikataApiUrl).toBeUndefined();
  });

  it('AIKATA_JWT環境変数からaikataJwtを取得できる', () => {
    const result = parseCliOptions([], { AIKATA_JWT: 'jwt-token-value' });
    expect(result.aikataJwt).toBe('jwt-token-value');
  });

  it('aikataJwtの未指定時はundefinedである', () => {
    const result = parseCliOptions([], {});
    expect(result.aikataJwt).toBeUndefined();
  });

  it('aikataJwtはCLIオプションからは設定できない（環境変数のみ）', () => {
    // aikataJwtにはCLIフラグがないため、環境変数からのみ取得される
    const result = parseCliOptions([], { AIKATA_JWT: 'env-jwt' });
    expect(result.aikataJwt).toBe('env-jwt');
  });

  describe('gitlabApiUrl', () => {
    it('--gitlab-api-urlオプションをパースできる', () => {
      const result = parseCliOptions(['--gitlab-api-url', 'https://gitlab-a.example.com/api/v4']);
      expect(result.gitlabApiUrl).toBe('https://gitlab-a.example.com/api/v4');
    });

    it('GITLAB_API_URL環境変数からgitlabApiUrlを取得できる', () => {
      const result = parseCliOptions([], {
        GITLAB_API_URL: 'https://gitlab-env.example.com/api/v4',
      });
      expect(result.gitlabApiUrl).toBe('https://gitlab-env.example.com/api/v4');
    });

    it('--gitlab-api-urlがGITLAB_API_URL環境変数より優先される', () => {
      const result = parseCliOptions(
        ['--gitlab-api-url', 'https://gitlab-cli.example.com/api/v4'],
        {
          GITLAB_API_URL: 'https://gitlab-env.example.com/api/v4',
        },
      );
      expect(result.gitlabApiUrl).toBe('https://gitlab-cli.example.com/api/v4');
    });

    it('GITLAB_API_URLが未指定の場合はCI_API_V4_URL環境変数が使用される', () => {
      const result = parseCliOptions([], {
        CI_API_V4_URL: 'https://gitlab-ci.example.com/api/v4',
      });
      expect(result.gitlabApiUrl).toBe('https://gitlab-ci.example.com/api/v4');
    });

    it('GITLAB_API_URLが空文字の場合もCI_API_V4_URL環境変数が使用される（空文字をundefined扱い）', () => {
      const result = parseCliOptions([], {
        GITLAB_API_URL: '',
        CI_API_V4_URL: 'https://gitlab-ci.example.com/api/v4',
      });
      expect(result.gitlabApiUrl).toBe('https://gitlab-ci.example.com/api/v4');
    });

    it('CI_API_V4_URLが空文字の場合はデフォルト値が使用される', () => {
      const result = parseCliOptions([], {
        GITLAB_API_URL: '',
        CI_API_V4_URL: '',
      });
      expect(result.gitlabApiUrl).toBe('https://gitlab.com/api/v4');
    });

    it('全て未指定の場合はデフォルト値https://gitlab.com/api/v4が使用される', () => {
      const result = parseCliOptions([], {});
      expect(result.gitlabApiUrl).toBe('https://gitlab.com/api/v4');
    });

    it('優先順位: CLI > GITLAB_API_URL > CI_API_V4_URL > デフォルト', () => {
      // CLI優先
      const r1 = parseCliOptions(['--gitlab-api-url', 'https://cli.example.com/api/v4'], {
        GITLAB_API_URL: 'https://env.example.com/api/v4',
        CI_API_V4_URL: 'https://ci.example.com/api/v4',
      });
      expect(r1.gitlabApiUrl).toBe('https://cli.example.com/api/v4');

      // GITLAB_API_URL優先
      const r2 = parseCliOptions([], {
        GITLAB_API_URL: 'https://env.example.com/api/v4',
        CI_API_V4_URL: 'https://ci.example.com/api/v4',
      });
      expect(r2.gitlabApiUrl).toBe('https://env.example.com/api/v4');

      // CI_API_V4_URL fallback
      const r3 = parseCliOptions([], { CI_API_V4_URL: 'https://ci.example.com/api/v4' });
      expect(r3.gitlabApiUrl).toBe('https://ci.example.com/api/v4');
    });
  });
});

describe('buildChecklistParseOptions', () => {
  it('checklistColumnsが未指定の場合はcolumnsがnullになる', () => {
    const result = buildChecklistParseOptions({
      checklistNoHeader: false,
      logLevel: 'info',
      commentLanguage: 'Japanese',
      prettyPrint: true,
      gitlabApiUrl: 'https://gitlab.com/api/v4',
    });
    expect(result.columns).toBeNull();
    expect(result.noHeader).toBe(false);
  });

  it('checklistColumnsからnumber[]に変換される', () => {
    const result = buildChecklistParseOptions({
      checklistColumns: '1,3',
      checklistNoHeader: false,
      logLevel: 'info',
      commentLanguage: 'Japanese',
      prettyPrint: true,
      gitlabApiUrl: 'https://gitlab.com/api/v4',
    });
    expect(result.columns).toEqual([1, 3]);
  });

  it('空白を含む列番号が正しくトリムされる', () => {
    const result = buildChecklistParseOptions({
      checklistColumns: ' 2 , 4 ',
      checklistNoHeader: false,
      logLevel: 'info',
      commentLanguage: 'Japanese',
      prettyPrint: true,
      gitlabApiUrl: 'https://gitlab.com/api/v4',
    });
    expect(result.columns).toEqual([2, 4]);
  });

  it('noHeaderがtrueの場合そのまま渡される', () => {
    const result = buildChecklistParseOptions({
      checklistNoHeader: true,
      logLevel: 'info',
      commentLanguage: 'Japanese',
      prettyPrint: true,
      gitlabApiUrl: 'https://gitlab.com/api/v4',
    });
    expect(result.noHeader).toBe(true);
  });

  it('不正な列番号（非整数）でエラーになる', () => {
    expect(() =>
      buildChecklistParseOptions({
        checklistColumns: '1.5',
        checklistNoHeader: false,
        logLevel: 'info',
        commentLanguage: 'Japanese',
        prettyPrint: true,
        gitlabApiUrl: 'https://gitlab.com/api/v4',
      }),
    ).toThrow('Invalid column number');
  });

  it('不正な列番号（0以下）でエラーになる', () => {
    expect(() =>
      buildChecklistParseOptions({
        checklistColumns: '0',
        checklistNoHeader: false,
        logLevel: 'info',
        commentLanguage: 'Japanese',
        prettyPrint: true,
        gitlabApiUrl: 'https://gitlab.com/api/v4',
      }),
    ).toThrow('Invalid column number');
  });

  it('不正な列番号（文字列）でエラーになる', () => {
    expect(() =>
      buildChecklistParseOptions({
        checklistColumns: 'abc',
        checklistNoHeader: false,
        logLevel: 'info',
        commentLanguage: 'Japanese',
        prettyPrint: true,
        gitlabApiUrl: 'https://gitlab.com/api/v4',
      }),
    ).toThrow('Invalid column number');
  });

  it('空白のみのchecklistColumnsはcolumnsがnullになる', () => {
    const result = buildChecklistParseOptions({
      checklistColumns: '  ',
      checklistNoHeader: false,
      logLevel: 'info',
      commentLanguage: 'Japanese',
      prettyPrint: true,
      gitlabApiUrl: 'https://gitlab.com/api/v4',
    });
    expect(result.columns).toBeNull();
  });
});
