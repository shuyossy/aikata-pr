/** 既定のGitLab APIベースURL */
const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4';

/** 環境変数値が未定義または空文字の場合にundefinedを返す */
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * pipeline-report サブコマンドの CLI オプション型。
 *
 * 必須チェックは commandBuilder の `validateRequiredParams` で行う。
 * 数値系は CLI 側では `string | undefined` のまま保持し、バリデーション時に変換する。
 */
export interface PipelineReportCliOptions {
  userId: string | undefined;
  projectId: string | undefined;
  pipelineId: string | undefined;
  /** レポート出力ジョブ自身のジョブID。未指定時は null として自己除外無し */
  selfJobId: string | undefined;
  pipelineReportSettings: string | undefined;
  skills: string | undefined;
  gitlabToken: string | undefined;
  aiModelName: string;
  logLevel: string;
  commentLanguage: string;
  prettyPrint: boolean;
  aikataApiUrl: string | undefined;
  aikataJwt: string | undefined;
  /** GitLab APIベースURL。優先順位: --gitlab-api-url > GITLAB_API_URL > CI_API_V4_URL > 既定値 */
  gitlabApiUrl: string;
  /** 結果ファイルの出力パス（必ず値が入る。デフォルト: `./aikata-pipeline-report.md`） */
  resultFile: string;
  /** 完成判定の最大リトライ回数（必ず値が入る。デフォルト: 3） */
  maxCompletenessRetries: number;
  /** フォルダツリー走査の最大深度。未指定時は undefined（無制限） */
  treeMaxDepth: number | undefined;
  /** 完成判定ステップをスキップするか（デフォルト: false） */
  skipCompletenessCheck: boolean;
}

/**
 * 文字列を正の整数に変換する。変換失敗時は英語メッセージで throw する。
 */
function parsePositiveInt(value: string, fieldName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${fieldName}: ${value}. Must be a positive integer.`);
  }
  return n;
}

/**
 * 文字列を非負整数に変換する（0 許容）。
 */
function parseNonNegativeInt(value: string, fieldName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${fieldName}: ${value}. Must be a non-negative integer.`);
  }
  return n;
}

/**
 * pipeline-report サブコマンドの CLI 引数および環境変数をパースする。
 *
 * 優先順位: CLIオプション > 環境変数 > デフォルト値
 *
 * 環境変数フォールバック:
 * - `--pipeline-id`: GITLAB_PIPELINE_ID を優先し、次に CI_PIPELINE_ID を参照
 * - `--self-job-id`: GITLAB_SELF_JOB_ID を優先し、次に CI_JOB_ID を参照
 *
 * @param args - コマンドライン引数配列（サブコマンドを除いた残り）
 * @param env - 環境変数マップ
 */
export function parsePipelineReportArgs(
  args: string[],
  env: Record<string, string | undefined>,
): PipelineReportCliOptions {
  const parsed: Record<string, string | boolean> = {};

  // CLIオプションをパース
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--user-id':
        parsed['userId'] = args[++i]!;
        break;
      case '--project-id':
        parsed['projectId'] = args[++i]!;
        break;
      case '--pipeline-id':
        parsed['pipelineId'] = args[++i]!;
        break;
      case '--self-job-id':
        parsed['selfJobId'] = args[++i]!;
        break;
      case '--pipeline-report-settings':
        parsed['pipelineReportSettings'] = args[++i]!;
        break;
      case '--skills':
        parsed['skills'] = args[++i]!;
        break;
      case '--aikata-pr-gitlab-token':
        parsed['gitlabToken'] = args[++i]!;
        break;
      case '--ai-model-name':
        parsed['aiModelName'] = args[++i]!;
        break;
      case '--log-level':
        parsed['logLevel'] = args[++i]!;
        break;
      case '--comment-language':
        parsed['commentLanguage'] = args[++i]!;
        break;
      case '--pretty-print':
        parsed['prettyPrint'] = true;
        break;
      case '--no-pretty-print':
        parsed['prettyPrint'] = false;
        break;
      case '--aikata-api-url':
        parsed['aikataApiUrl'] = args[++i]!;
        break;
      case '--result-file':
        parsed['resultFile'] = args[++i]!;
        break;
      case '--max-completeness-retries':
        parsed['maxCompletenessRetries'] = args[++i]!;
        break;
      case '--tree-max-depth':
        parsed['treeMaxDepth'] = args[++i]!;
        break;
      case '--skip-completeness-check':
        parsed['skipCompletenessCheck'] = true;
        break;
      case '--gitlab-api-url':
        parsed['gitlabApiUrl'] = args[++i]!;
        break;
    }
  }

  // pipelineId は GITLAB_PIPELINE_ID を優先し、未指定なら CI_PIPELINE_ID を参照
  const pipelineIdFallback = env['GITLAB_PIPELINE_ID'] ?? env['CI_PIPELINE_ID'];
  // selfJobId は GITLAB_SELF_JOB_ID を優先し、未指定なら CI_JOB_ID を参照
  const selfJobIdFallback = env['GITLAB_SELF_JOB_ID'] ?? env['CI_JOB_ID'];

  // 結果ファイル
  const resultFile =
    (parsed['resultFile'] as string) ??
    env['PIPELINE_REPORT_RESULT_FILE'] ??
    './aikata-pipeline-report.md';

  // 完成判定リトライ回数（CLI > env > default(3)）
  const maxCompletenessRetriesRaw =
    (parsed['maxCompletenessRetries'] as string) ?? env['PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES'];
  const maxCompletenessRetries =
    maxCompletenessRetriesRaw !== undefined
      ? parseNonNegativeInt(maxCompletenessRetriesRaw, 'max-completeness-retries')
      : 3;

  // フォルダツリー最大深度（指定があれば正の整数、未指定なら undefined）
  const treeMaxDepthRaw = (parsed['treeMaxDepth'] as string) ?? env['TREE_MAX_DEPTH'];
  const treeMaxDepth =
    treeMaxDepthRaw !== undefined ? parsePositiveInt(treeMaxDepthRaw, 'tree-max-depth') : undefined;

  // 完成判定スキップ（CLI > env > default(false)）
  const skipCompletenessCheck =
    parsed['skipCompletenessCheck'] !== undefined
      ? (parsed['skipCompletenessCheck'] as boolean)
      : env['PIPELINE_REPORT_SKIP_COMPLETENESS_CHECK'] !== undefined
        ? env['PIPELINE_REPORT_SKIP_COMPLETENESS_CHECK'] === 'true'
        : false;

  return {
    userId: (parsed['userId'] as string) ?? env['USER_ID'],
    projectId: (parsed['projectId'] as string) ?? env['GITLAB_PROJECT_ID'],
    pipelineId: (parsed['pipelineId'] as string) ?? pipelineIdFallback,
    selfJobId: (parsed['selfJobId'] as string) ?? selfJobIdFallback,
    pipelineReportSettings:
      (parsed['pipelineReportSettings'] as string) ?? env['PIPELINE_REPORT_SETTINGS_PATH'],
    skills: (parsed['skills'] as string) ?? env['SKILLS_PATH'],
    gitlabToken: (parsed['gitlabToken'] as string) ?? env['AIKATA_PR_GITLAB_TOKEN'],
    aiModelName: (parsed['aiModelName'] as string) ?? env['AI_MODEL_NAME'] ?? 'openai/o4-mini',
    logLevel: (parsed['logLevel'] as string) ?? env['AIKATA_LOG_LEVEL'] ?? 'info',
    commentLanguage: (parsed['commentLanguage'] as string) ?? env['COMMENT_LANGUAGE'] ?? 'Japanese',
    prettyPrint:
      parsed['prettyPrint'] !== undefined
        ? (parsed['prettyPrint'] as boolean)
        : env['PRETTY_PRINT'] !== undefined
          ? env['PRETTY_PRINT'] === 'true'
          : true,
    aikataApiUrl: (parsed['aikataApiUrl'] as string) ?? env['AIKATA_API_URL'],
    aikataJwt: env['AIKATA_JWT'],
    gitlabApiUrl:
      (parsed['gitlabApiUrl'] as string) ??
      nonEmpty(env['GITLAB_API_URL']) ??
      nonEmpty(env['CI_API_V4_URL']) ??
      DEFAULT_GITLAB_API_URL,
    resultFile,
    maxCompletenessRetries,
    treeMaxDepth,
    skipCompletenessCheck,
  };
}
