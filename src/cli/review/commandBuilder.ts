import type { CliOptions } from './parseReviewArgs.js';
import type { ReviewExecutionCommand } from '../../application/review/reviewExecution/ReviewExecutionCommand.js';
import type { ReviewApiRequest } from '../../infrastructure/adapter/review/apiClient/ReviewApiClient.js';
import type { Checklist } from '../../domain/review/checklist/index.js';
import type { ReviewSettings } from '../../domain/review/reviewSettings/index.js';

/**
 * ローカルモード判定
 * AI_API_KEY, AI_API_ENDPOINT_URL, AI_MODEL_NAMEが全て設定されている場合にローカルモードとする
 */
export function isLocalMode(options: CliOptions, env: Record<string, string | undefined>): boolean {
  return !!(options.aiModelName && env['AI_API_KEY'] && env['AI_API_ENDPOINT_URL']);
}

/**
 * バリデーション済みの必須パラメータ
 */
export interface ValidatedParams {
  userId: string;
  projectId: string;
  mrIid: string;
  gitlabToken: string;
  /** GitLab APIベースURL。CLIオプション/環境変数/既定値から解決済み */
  gitlabApiUrl: string;
  checklistPath: string;
  aiApiKey?: string;
  aiApiEndpointUrl?: string;
  aiModelName?: string;
}

/**
 * 必須パラメータの存在をバリデーションする
 * APIモード時はAI関連パラメータを不要とする
 */
export function validateRequiredParams(
  options: CliOptions,
  env: Record<string, string | undefined>,
): ValidatedParams {
  const missing: string[] = [];
  if (!options.userId) missing.push('--user-id or USER_ID');
  if (!options.projectId) missing.push('--project-id or GITLAB_PROJECT_ID');
  if (!options.mrIid) missing.push('--mr-iid or GITLAB_MR_IID');
  if (!options.gitlabToken) missing.push('--aikata-pr-gitlab-token or AIKATA_PR_GITLAB_TOKEN');
  if (!options.checklist) missing.push('--checklist or CHECKLIST_PATH');

  // APIモードの場合のみAIKATA_API_URLとAIKATA_JWTを必須とする
  if (!isLocalMode(options, env)) {
    if (!options.aikataApiUrl) missing.push('--aikata-api-url or AIKATA_API_URL');
    if (!options.aikataJwt) missing.push('AIKATA_JWT');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required parameters: ${missing.join(', ')}`);
  }

  return {
    userId: options.userId!,
    projectId: options.projectId!,
    mrIid: options.mrIid!,
    gitlabToken: options.gitlabToken!,
    gitlabApiUrl: options.gitlabApiUrl,
    checklistPath: options.checklist!,
    aiModelName: options.aiModelName,
    aiApiKey: env['AI_API_KEY'],
    aiApiEndpointUrl: env['AI_API_ENDPOINT_URL'],
  };
}

/**
 * APIモード用: CLI optionsからReviewApiRequestを構築する
 */
export function buildApiReviewRequest(
  validated: ValidatedParams,
  checklist: Checklist,
  reviewSettings: ReviewSettings,
  options: CliOptions,
  treeMaxDepth: number | undefined,
): ReviewApiRequest {
  return {
    userId: validated.userId,
    gitlabToken: validated.gitlabToken,
    gitlabApiUrl: validated.gitlabApiUrl,
    projectId: validated.projectId,
    mrIid: validated.mrIid,
    checklist: checklist.items.map((i) => i.content),
    reviewSettings: {
      additionalInstructions: reviewSettings.additionalInstructions,
      concurrentReviewCount: reviewSettings.concurrentReviewCount,
      commentFormat: reviewSettings.commentFormat,
      ratings: reviewSettings.ratings.map((r) => ({
        label: r.label,
        definition: r.definition,
      })),
      hiddenRatingLabels: reviewSettings.hiddenRatingLabels,
      suggestEnabledRatingLabels: reviewSettings.suggestEnabledRatingLabels,
      qualityGate: {
        failureCriteria: reviewSettings.qualityGate.failureCriteria.map((c) => ({
          ratingLabel: c.ratingLabel,
          threshold: c.threshold,
        })),
      },
      mrCommentTitle: reviewSettings.mrCommentTitle,
    },
    options: {
      commentLanguage: options.commentLanguage,
      skillsPaths: options.skills ? [options.skills] : [],
      treeMaxDepth,
    },
  };
}

/**
 * ローカルモード用: CLI optionsからReviewExecutionCommandを構築する
 */
export function buildLocalReviewCommand(
  validated: ValidatedParams,
  checklist: Checklist,
  reviewSettings: ReviewSettings,
  options: CliOptions,
  projectDir: string,
  treeMaxDepth: number | undefined,
  maxContextLength: number | undefined,
  openaiReasoningEffort: string | undefined,
): ReviewExecutionCommand {
  return {
    userId: validated.userId,
    projectId: validated.projectId,
    mrIid: validated.mrIid,
    checklist,
    reviewSettings,
    skillsPaths: options.skills ? [options.skills] : [],
    projectDir,
    aiApiKey: validated.aiApiKey!,
    aiApiEndpointUrl: validated.aiApiEndpointUrl!,
    aiModelName: validated.aiModelName!,
    gitlabToken: validated.gitlabToken,
    treeMaxDepth,
    commentLanguage: options.commentLanguage,
    openaiReasoningEffort,
    maxContextLength,
  };
}
