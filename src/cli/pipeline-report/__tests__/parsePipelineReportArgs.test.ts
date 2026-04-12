import { describe, it, expect } from 'vitest';
import { parsePipelineReportArgs } from '../parsePipelineReportArgs.js';

describe('parsePipelineReportArgs', () => {
  it('--user-idをパースできる', () => {
    const result = parsePipelineReportArgs(['--user-id', 'alice'], {});
    expect(result.userId).toBe('alice');
  });

  it('USER_ID環境変数にフォールバックする', () => {
    const result = parsePipelineReportArgs([], { USER_ID: 'env-user' });
    expect(result.userId).toBe('env-user');
  });

  it('CLIオプションが環境変数より優先される', () => {
    const result = parsePipelineReportArgs(['--user-id', 'cli-user'], { USER_ID: 'env-user' });
    expect(result.userId).toBe('cli-user');
  });

  it('--project-idをパースできる', () => {
    const result = parsePipelineReportArgs(['--project-id', '12'], {});
    expect(result.projectId).toBe('12');
  });

  it('GITLAB_PROJECT_IDにフォールバックする', () => {
    const result = parsePipelineReportArgs([], { GITLAB_PROJECT_ID: '99' });
    expect(result.projectId).toBe('99');
  });

  it('--pipeline-idをパースできる', () => {
    const result = parsePipelineReportArgs(['--pipeline-id', '456'], {});
    expect(result.pipelineId).toBe('456');
  });

  it('GITLAB_PIPELINE_IDにフォールバックする', () => {
    const result = parsePipelineReportArgs([], { GITLAB_PIPELINE_ID: '777' });
    expect(result.pipelineId).toBe('777');
  });

  it('GITLAB_PIPELINE_IDが無い場合CI_PIPELINE_IDにフォールバックする', () => {
    const result = parsePipelineReportArgs([], { CI_PIPELINE_ID: '888' });
    expect(result.pipelineId).toBe('888');
  });

  it('GITLAB_PIPELINE_IDがCI_PIPELINE_IDより優先される', () => {
    const result = parsePipelineReportArgs([], {
      GITLAB_PIPELINE_ID: '111',
      CI_PIPELINE_ID: '222',
    });
    expect(result.pipelineId).toBe('111');
  });

  it('--self-job-idをパースできる', () => {
    const result = parsePipelineReportArgs(['--self-job-id', '12345'], {});
    expect(result.selfJobId).toBe('12345');
  });

  it('GITLAB_SELF_JOB_IDにフォールバックする', () => {
    const result = parsePipelineReportArgs([], { GITLAB_SELF_JOB_ID: '900' });
    expect(result.selfJobId).toBe('900');
  });

  it('GITLAB_SELF_JOB_IDが無い場合CI_JOB_IDにフォールバックする', () => {
    const result = parsePipelineReportArgs([], { CI_JOB_ID: '600' });
    expect(result.selfJobId).toBe('600');
  });

  it('selfJobIdが未指定ならundefinedを返す', () => {
    const result = parsePipelineReportArgs([], {});
    expect(result.selfJobId).toBeUndefined();
  });

  it('--pipeline-report-settingsをパースできる', () => {
    const result = parsePipelineReportArgs(
      ['--pipeline-report-settings', '/path/to/settings.json'],
      {},
    );
    expect(result.pipelineReportSettings).toBe('/path/to/settings.json');
  });

  it('PIPELINE_REPORT_SETTINGS_PATHにフォールバックする', () => {
    const result = parsePipelineReportArgs([], {
      PIPELINE_REPORT_SETTINGS_PATH: '/env/settings.json',
    });
    expect(result.pipelineReportSettings).toBe('/env/settings.json');
  });

  it('--skillsをパースできる', () => {
    const result = parsePipelineReportArgs(['--skills', '/path/to/skills'], {});
    expect(result.skills).toBe('/path/to/skills');
  });

  it('--aikata-pr-gitlab-tokenをパースできる', () => {
    const result = parsePipelineReportArgs(['--aikata-pr-gitlab-token', 'glt-token'], {});
    expect(result.gitlabToken).toBe('glt-token');
  });

  it('AIKATA_PR_GITLAB_TOKENにフォールバックする', () => {
    const result = parsePipelineReportArgs([], { AIKATA_PR_GITLAB_TOKEN: 'env-token' });
    expect(result.gitlabToken).toBe('env-token');
  });

  it('--ai-model-name未指定時にデフォルト openai/o4-mini を返す', () => {
    const result = parsePipelineReportArgs([], {});
    expect(result.aiModelName).toBe('openai/o4-mini');
  });

  it('--ai-model-nameをパースできる', () => {
    const result = parsePipelineReportArgs(['--ai-model-name', 'openai/gpt-4'], {});
    expect(result.aiModelName).toBe('openai/gpt-4');
  });

  it('AI_MODEL_NAME環境変数にフォールバックする', () => {
    const result = parsePipelineReportArgs([], { AI_MODEL_NAME: 'anthropic/claude-3' });
    expect(result.aiModelName).toBe('anthropic/claude-3');
  });

  it('--log-level未指定時にデフォルトinfoを返す', () => {
    const result = parsePipelineReportArgs([], {});
    expect(result.logLevel).toBe('info');
  });

  it('--comment-language未指定時にデフォルトJapaneseを返す', () => {
    const result = parsePipelineReportArgs([], {});
    expect(result.commentLanguage).toBe('Japanese');
  });

  it('--aikata-api-urlをパースできる', () => {
    const result = parsePipelineReportArgs(['--aikata-api-url', 'https://api.example.com'], {});
    expect(result.aikataApiUrl).toBe('https://api.example.com');
  });

  it('AIKATA_API_URLにフォールバックする', () => {
    const result = parsePipelineReportArgs([], { AIKATA_API_URL: 'https://env.example.com' });
    expect(result.aikataApiUrl).toBe('https://env.example.com');
  });

  it('AIKATA_JWTは環境変数のみから取得される', () => {
    const result = parsePipelineReportArgs([], { AIKATA_JWT: 'jwt-token' });
    expect(result.aikataJwt).toBe('jwt-token');
  });

  it('--result-fileをパースできる', () => {
    const result = parsePipelineReportArgs(['--result-file', '/tmp/report.md'], {});
    expect(result.resultFile).toBe('/tmp/report.md');
  });

  it('PIPELINE_REPORT_RESULT_FILEにフォールバックする', () => {
    const result = parsePipelineReportArgs([], {
      PIPELINE_REPORT_RESULT_FILE: '/env/report.md',
    });
    expect(result.resultFile).toBe('/env/report.md');
  });

  it('resultFileのデフォルトは./aikata-pipeline-report.md', () => {
    const result = parsePipelineReportArgs([], {});
    expect(result.resultFile).toBe('./aikata-pipeline-report.md');
  });

  it('--max-completeness-retriesをパースできる', () => {
    const result = parsePipelineReportArgs(['--max-completeness-retries', '5'], {});
    expect(result.maxCompletenessRetries).toBe(5);
  });

  it('PIPELINE_REPORT_MAX_COMPLETENESS_RETRIESにフォールバックする', () => {
    const result = parsePipelineReportArgs([], {
      PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES: '2',
    });
    expect(result.maxCompletenessRetries).toBe(2);
  });

  it('maxCompletenessRetriesのデフォルトは3', () => {
    const result = parsePipelineReportArgs([], {});
    expect(result.maxCompletenessRetries).toBe(3);
  });

  it('max-completeness-retriesが負の値ならエラー', () => {
    expect(() => parsePipelineReportArgs(['--max-completeness-retries', '-1'], {})).toThrow(
      /Invalid max-completeness-retries/,
    );
  });

  it('max-completeness-retriesが非整数ならエラー', () => {
    expect(() => parsePipelineReportArgs(['--max-completeness-retries', 'abc'], {})).toThrow(
      /Invalid max-completeness-retries/,
    );
  });

  it('--tree-max-depthをパースできる', () => {
    const result = parsePipelineReportArgs(['--tree-max-depth', '5'], {});
    expect(result.treeMaxDepth).toBe(5);
  });

  it('TREE_MAX_DEPTH環境変数にフォールバックする', () => {
    const result = parsePipelineReportArgs([], { TREE_MAX_DEPTH: '7' });
    expect(result.treeMaxDepth).toBe(7);
  });

  it('treeMaxDepth未指定ならundefined', () => {
    const result = parsePipelineReportArgs([], {});
    expect(result.treeMaxDepth).toBeUndefined();
  });

  it('tree-max-depthが0以下なら例外', () => {
    expect(() => parsePipelineReportArgs(['--tree-max-depth', '0'], {})).toThrow(
      /Invalid tree-max-depth/,
    );
  });

  it('tree-max-depthが非整数なら例外', () => {
    expect(() => parsePipelineReportArgs(['--tree-max-depth', '1.5'], {})).toThrow(
      /Invalid tree-max-depth/,
    );
  });

  it('全オプションを一括でパースできる', () => {
    const result = parsePipelineReportArgs(
      [
        '--user-id',
        'u1',
        '--project-id',
        '10',
        '--pipeline-id',
        '20',
        '--self-job-id',
        '30',
        '--pipeline-report-settings',
        '/settings.json',
        '--skills',
        '/skills',
        '--aikata-pr-gitlab-token',
        'token',
        '--ai-model-name',
        'openai/o4-mini',
        '--log-level',
        'debug',
        '--comment-language',
        'English',
        '--aikata-api-url',
        'https://api.example.com',
        '--result-file',
        '/tmp/out.md',
        '--max-completeness-retries',
        '5',
        '--tree-max-depth',
        '4',
        '--pretty-print',
      ],
      {},
    );
    expect(result.userId).toBe('u1');
    expect(result.projectId).toBe('10');
    expect(result.pipelineId).toBe('20');
    expect(result.selfJobId).toBe('30');
    expect(result.pipelineReportSettings).toBe('/settings.json');
    expect(result.skills).toBe('/skills');
    expect(result.gitlabToken).toBe('token');
    expect(result.aiModelName).toBe('openai/o4-mini');
    expect(result.logLevel).toBe('debug');
    expect(result.commentLanguage).toBe('English');
    expect(result.aikataApiUrl).toBe('https://api.example.com');
    expect(result.resultFile).toBe('/tmp/out.md');
    expect(result.maxCompletenessRetries).toBe(5);
    expect(result.treeMaxDepth).toBe(4);
    expect(result.prettyPrint).toBe(true);
  });
});
