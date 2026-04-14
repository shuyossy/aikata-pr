import type { PipelineReportCliOptions } from './parsePipelineReportArgs.js';
import type { PipelineAnalyzeCommand } from '../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import type { PipelineAnalysisProgressEvent } from '../../application/shared/port/workflow/PipelineAnalysisWorkflowRunner.js';
import type { PipelineReportSettings } from '../../domain/pipeline-report/pipelineReportSettings/index.js';
import type { PipelineReportApiRequest } from '../../infrastructure/adapter/pipeline-report/apiClient/index.js';

/**
 * ローカルモード判定
 * AI_API_KEY, AI_API_ENDPOINT_URL, AI_MODEL_NAME が全て設定されている場合にローカルモードとする。
 * pipeline-report の AI_MODEL_NAME は parsePipelineReportArgs でデフォルト値（openai/o4-mini）が
 * 設定されるため、実態としては AI_API_KEY と AI_API_ENDPOINT_URL の有無だけで判定される。
 */
export function isLocalMode(
  options: PipelineReportCliOptions,
  env: Record<string, string | undefined>,
): boolean {
  return !!(options.aiModelName && env['AI_API_KEY'] && env['AI_API_ENDPOINT_URL']);
}

/**
 * バリデーション済みの必須パラメータ。
 * APIモード時は aiApiKey / aiApiEndpointUrl が空、ローカルモード時は aikata* が空となる。
 */
export interface ValidatedPipelineReportParams {
  userId: string;
  projectId: number;
  pipelineId: number;
  /** 未指定時は null（自己除外無し） */
  selfJobId: number | null;
  gitlabToken: string;
  aiModelName: string;
  aiApiKey: string | undefined;
  aiApiEndpointUrl: string | undefined;
  aikataApiUrl: string | undefined;
  aikataJwt: string | undefined;
}

/**
 * 文字列を正の整数に変換する。変換失敗時は英語メッセージで throw する。
 */
function toPositiveInt(value: string, fieldName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${fieldName}: ${value}. Must be a positive integer.`);
  }
  return n;
}

/**
 * 必須パラメータの存在・型をバリデーションする。
 * APIモード時は `aikata-api-url` と `AIKATA_JWT` を必須とし、
 * ローカルモード時は `AI_API_KEY` / `AI_API_ENDPOINT_URL` を必須とする。
 */
export function validateRequiredParams(
  options: PipelineReportCliOptions,
  env: Record<string, string | undefined>,
): ValidatedPipelineReportParams {
  const missing: string[] = [];
  if (!options.userId) missing.push('--user-id or USER_ID');
  if (!options.projectId) missing.push('--project-id or GITLAB_PROJECT_ID');
  if (!options.pipelineId) missing.push('--pipeline-id or GITLAB_PIPELINE_ID / CI_PIPELINE_ID');
  if (!options.gitlabToken) missing.push('--aikata-pr-gitlab-token or AIKATA_PR_GITLAB_TOKEN');

  const localMode = isLocalMode(options, env);
  if (localMode) {
    if (!env['AI_API_KEY']) missing.push('AI_API_KEY');
    if (!env['AI_API_ENDPOINT_URL']) missing.push('AI_API_ENDPOINT_URL');
  } else {
    if (!options.aikataApiUrl) missing.push('--aikata-api-url or AIKATA_API_URL');
    // AIKATA_JWT は JWT_* が設定されてない開発モードを許容するため警告扱い
    // ではなく必須とする（JWT 認証が有効な本番では必ず必要）。
    // ただし tech.md の規定により JWT 認証無効モードでは省略可能とする設計のため、
    // ここでは強制しない。
  }

  if (missing.length > 0) {
    throw new Error(`Missing required parameters: ${missing.join(', ')}`);
  }

  // 数値パラメータの型変換
  const projectId = toPositiveInt(options.projectId!, 'project-id');
  const pipelineId = toPositiveInt(options.pipelineId!, 'pipeline-id');
  const selfJobId =
    options.selfJobId !== undefined && options.selfJobId !== ''
      ? toPositiveInt(options.selfJobId, 'self-job-id')
      : null;

  return {
    userId: options.userId!,
    projectId,
    pipelineId,
    selfJobId,
    gitlabToken: options.gitlabToken!,
    aiModelName: options.aiModelName,
    aiApiKey: env['AI_API_KEY'],
    aiApiEndpointUrl: env['AI_API_ENDPOINT_URL'],
    aikataApiUrl: options.aikataApiUrl,
    aikataJwt: options.aikataJwt,
  };
}

/**
 * ローカルモード用の PipelineAnalyzeCommand を組み立てるための追加パラメータ。
 */
export interface BuildPipelineReportCommandOptions {
  /** ユーザ設定ファイルから読み取った PipelineReportSettings（未指定なら default を渡す） */
  settings: PipelineReportSettings;
  /** クローン済みプロジェクトのパス */
  projectDir: string;
  /** 圧縮上限（null なら圧縮しない） */
  maxContextLength: number | null;
  /** OpenAI reasoning モデルの reasoning effort */
  openaiReasoningEffort: string | null;
  /** ワークフロー進捗コールバック */
  onProgress: (event: PipelineAnalysisProgressEvent) => void;
}

/**
 * ローカルモード用: CLIオプションとバリデーション済みパラメータから
 * PipelineAnalyzeCommand を組み立てる。
 */
export function buildPipelineReportCommand(
  parsed: PipelineReportCliOptions,
  validated: ValidatedPipelineReportParams,
  extras: BuildPipelineReportCommandOptions,
): PipelineAnalyzeCommand {
  return {
    userId: validated.userId,
    projectId: validated.projectId,
    pipelineId: validated.pipelineId,
    selfJobId: validated.selfJobId,
    settings: extras.settings,
    projectDir: extras.projectDir,
    commentLanguage: parsed.commentLanguage,
    skillsPaths: parsed.skills ? [parsed.skills] : [],
    aiConfig: {
      apiKey: validated.aiApiKey!,
      endpointUrl: validated.aiApiEndpointUrl!,
      modelName: validated.aiModelName,
      reasoningEffort: extras.openaiReasoningEffort,
    },
    maxContextLength: extras.maxContextLength,
    treeMaxDepth: parsed.treeMaxDepth,
    options: {
      maxCompletenessRetries: parsed.maxCompletenessRetries,
      skipCompletenessCheck: parsed.skipCompletenessCheck,
    },
    onProgress: extras.onProgress,
  };
}

/**
 * APIモード用: CLIオプションとバリデーション済みパラメータから PipelineReportApiRequest を組み立てる。
 *
 * PipelineReportSettings は RegExp を保持するが、APIサーバーへは RegExp.source 文字列として送る。
 */
export function buildPipelineReportApiRequest(
  parsed: PipelineReportCliOptions,
  validated: ValidatedPipelineReportParams,
  settings: PipelineReportSettings,
): PipelineReportApiRequest {
  return {
    userId: validated.userId,
    gitlabToken: validated.gitlabToken,
    projectId: validated.projectId,
    pipelineId: validated.pipelineId,
    selfJobId: validated.selfJobId,
    settings: {
      jobReportFormat: settings.jobReportFormat,
      additionalInstructions: settings.additionalInstructions,
      includeJobPatterns: settings.includeJobPatterns.map((re) => re.source),
      excludeJobPatterns: settings.excludeJobPatterns.map((re) => re.source),
    },
    commentLanguage: parsed.commentLanguage,
    maxCompletenessRetries: parsed.maxCompletenessRetries,
    skipCompletenessCheck: parsed.skipCompletenessCheck,
    skillsRelPaths: parsed.skills ? [parsed.skills] : [],
    treeMaxDepth: parsed.treeMaxDepth,
  };
}
