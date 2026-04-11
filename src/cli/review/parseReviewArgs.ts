import type { ChecklistParseOptions } from '../../application/shared/parser/index.js';

/**
 * CLIオプションの型定義
 */
export interface CliOptions {
  userId?: string;
  projectId?: string;
  mrIid?: string;
  gitlabToken?: string;
  checklist?: string;
  checklistColumns?: string;
  checklistNoHeader: boolean;
  reviewSettings?: string;
  skills?: string;
  logLevel: string;
  aiModelName?: string;
  commentLanguage: string;
  prettyPrint: boolean;
  aikataApiUrl?: string;
  aikataJwt?: string;
}

/**
 * CLIの引数と環境変数からオプションをパースする
 *
 * 優先順位: CLIオプション > 環境変数 > デフォルト値
 *
 * @param args - コマンドライン引数の配列
 * @param env - 環境変数のマップ
 * @returns パースされたCLIオプション
 */
export function parseCliOptions(
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): CliOptions {
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
      case '--mr-iid':
        parsed['mrIid'] = args[++i]!;
        break;
      case '--checklist':
        parsed['checklist'] = args[++i]!;
        break;
      case '--checklist-columns':
        parsed['checklistColumns'] = args[++i]!;
        break;
      case '--checklist-no-header':
        parsed['checklistNoHeader'] = true;
        break;
      case '--review-settings':
        parsed['reviewSettings'] = args[++i]!;
        break;
      case '--aikata-pr-gitlab-token':
        parsed['gitlabToken'] = args[++i]!;
        break;
      case '--skills':
        parsed['skills'] = args[++i]!;
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
    }
  }

  return {
    userId: (parsed['userId'] as string) ?? env['USER_ID'],
    projectId: (parsed['projectId'] as string) ?? env['GITLAB_PROJECT_ID'],
    mrIid: (parsed['mrIid'] as string) ?? env['GITLAB_MR_IID'],
    gitlabToken: (parsed['gitlabToken'] as string) ?? env['AIKATA_PR_GITLAB_TOKEN'],
    checklist: (parsed['checklist'] as string) ?? env['CHECKLIST_PATH'],
    checklistColumns: (parsed['checklistColumns'] as string) ?? env['CHECKLIST_COLUMNS'],
    checklistNoHeader:
      parsed['checklistNoHeader'] !== undefined
        ? (parsed['checklistNoHeader'] as boolean)
        : env['CHECKLIST_NO_HEADER'] !== undefined
          ? env['CHECKLIST_NO_HEADER'] === 'true'
          : false,
    reviewSettings: (parsed['reviewSettings'] as string) ?? env['REVIEW_SETTINGS_PATH'],
    skills: (parsed['skills'] as string) ?? env['SKILLS_PATH'],
    logLevel: (parsed['logLevel'] as string) ?? env['AIKATA_LOG_LEVEL'] ?? 'info',
    aiModelName: (parsed['aiModelName'] as string) ?? env['AI_MODEL_NAME'],
    commentLanguage: (parsed['commentLanguage'] as string) ?? env['COMMENT_LANGUAGE'] ?? 'Japanese',
    prettyPrint:
      parsed['prettyPrint'] !== undefined
        ? (parsed['prettyPrint'] as boolean)
        : env['PRETTY_PRINT'] !== undefined
          ? env['PRETTY_PRINT'] === 'true'
          : true,
    aikataApiUrl: (parsed['aikataApiUrl'] as string) ?? env['AIKATA_API_URL'],
    aikataJwt: env['AIKATA_JWT'],
  };
}

/**
 * CLIオプションからChecklistParseOptionsを構築する
 */
export function buildChecklistParseOptions(options: CliOptions): ChecklistParseOptions {
  let columns: number[] | null = null;

  if (options.checklistColumns?.trim()) {
    columns = options.checklistColumns.split(',').map((s) => {
      const n = Number(s.trim());
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid column number: ${s.trim()}`);
      }
      return n;
    });
  }

  return {
    columns,
    noHeader: options.checklistNoHeader,
  };
}
