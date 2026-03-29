/**
 * CLIオプションの型定義
 */
export interface CliOptions {
  userId?: string;
  projectId?: string;
  mrIid?: string;
  gitlabToken?: string;
  checklist?: string;
  reviewSettings?: string;
  skills?: string;
  logLevel: string;
  verboseError: boolean;
  aiModelName: string;
  commentLanguage: string;
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
      case '--review-settings':
        parsed['reviewSettings'] = args[++i]!;
        break;
      case '--gitlab-token':
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
      case '--verbose-error':
        parsed['verboseError'] = true;
        break;
      case '--comment-language':
        parsed['commentLanguage'] = args[++i]!;
        break;
    }
  }

  return {
    userId: (parsed['userId'] as string) ?? env['USER_ID'],
    projectId: (parsed['projectId'] as string) ?? env['GITLAB_PROJECT_ID'],
    mrIid: (parsed['mrIid'] as string) ?? env['GITLAB_MR_IID'],
    gitlabToken: (parsed['gitlabToken'] as string) ?? env['GITLAB_TOKEN'],
    checklist: (parsed['checklist'] as string) ?? env['CHECKLIST_PATH'],
    reviewSettings: (parsed['reviewSettings'] as string) ?? env['REVIEW_SETTINGS_PATH'],
    skills: (parsed['skills'] as string) ?? env['SKILLS_PATH'],
    logLevel: (parsed['logLevel'] as string) ?? env['LOG_LEVEL'] ?? 'info',
    verboseError: (parsed['verboseError'] as boolean) ?? env['VERBOSE_ERROR'] === 'true',
    aiModelName: (parsed['aiModelName'] as string) ?? env['AI_MODEL_NAME'] ?? 'openai/o4-mini',
    commentLanguage: (parsed['commentLanguage'] as string) ?? env['COMMENT_LANGUAGE'] ?? 'Japanese',
  };
}
