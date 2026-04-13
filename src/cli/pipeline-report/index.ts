import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CliFeatureModule } from '../dispatch.js';
import { parsePipelineReportArgs } from './parsePipelineReportArgs.js';
import {
  isLocalMode,
  validateRequiredParams,
  buildPipelineReportCommand,
  buildPipelineReportApiRequest,
} from './commandBuilder.js';
import { initializeLogger, getLogger, flushLogger, runWithLogContext } from '../../lib/logger.js';
import { parsePipelineReportSettings } from '../../application/shared/parser/index.js';
import { PipelineReportSettings } from '../../domain/pipeline-report/pipelineReportSettings/index.js';
import { PipelineAnalysisService } from '../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import type {
  PipelineAnalyzeCommand,
  PipelineAnalysisResult,
} from '../../application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.js';
import { YauzlArtifactArchiveReader } from '../../application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.js';
import { ArtifactCacheManager } from '../../application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.js';
import { GitLabApiClient } from '../../infrastructure/adapter/httpClient/index.js';
import { LocalProjectTreeGateway } from '../../infrastructure/adapter/gateway/index.js';
import { GitLabPipelineGateway } from '../../infrastructure/adapter/pipeline-report/gateway/GitLabPipelineGateway.js';
import { MastraPipelineAnalysisWorkflowRunner } from '../../infrastructure/adapter/pipeline-report/workflow/MastraPipelineAnalysisWorkflowRunner.js';
import {
  PipelineReportApiClient,
  type PipelineReportApiClientConfig,
  type PipelineReportProgressEvent,
} from '../../infrastructure/adapter/pipeline-report/apiClient/index.js';
import { GptTokenCounter } from '../../infrastructure/adapter/tokenCounter/index.js';
import { mastra } from '../../mastra/index.js';
import { RateLimiter } from '../../infrastructure/adapter/rateLimiter/index.js';
import { initializeRateLimiter, resetRateLimiter } from '../../lib/rateLimiterGlobal.js';

/**
 * ローカル実行時に PipelineAnalysisService を組み立てる際のDIポート。
 * テスト時は fake を注入できる。
 */
export interface PipelineReportLocalDeps {
  /** 実行対象の PipelineAnalysisService（analyze のみ使用） */
  service: { analyze(command: PipelineAnalyzeCommand): Promise<PipelineAnalysisResult> };
  /**
   * service 実行後にクリーンアップすべきリソースがあれば呼ばれる。
   * 例: RateLimiter.destroy など
   */
  cleanup: () => void;
}

/**
 * APIモード時の外部依存（PipelineReportApiClient の生成）。
 * テスト時は fake を注入できる。
 */
export interface PipelineReportApiDeps {
  createClient(config: PipelineReportApiClientConfig): {
    run(
      request: Parameters<PipelineReportApiClient['run']>[0],
      handlers: Parameters<PipelineReportApiClient['run']>[1],
    ): Promise<Awaited<ReturnType<PipelineReportApiClient['run']>>>;
  };
}

/**
 * run() の追加オプション。テストからfake依存を注入する用途。
 * 省略時はプロダクション用のDIで組み立てる。
 */
export interface RunOptions {
  localDepsFactory?: (context: {
    parsed: ReturnType<typeof parsePipelineReportArgs>;
    validated: ReturnType<typeof validateRequiredParams>;
    env: Record<string, string | undefined>;
  }) => PipelineReportLocalDeps;
  apiDeps?: PipelineReportApiDeps;
}

/**
 * ローカルモード用のデフォルトDIファクトリ。
 * PipelineAnalysisService と必要なインフラを組み立てる。
 */
function defaultLocalDepsFactory(context: {
  parsed: ReturnType<typeof parsePipelineReportArgs>;
  validated: ReturnType<typeof validateRequiredParams>;
  env: Record<string, string | undefined>;
}): PipelineReportLocalDeps {
  const { validated, env } = context;

  // レートリミッターをローカルモード用に初期化（review機能と共有の仕組み）
  resetRateLimiter();
  const rateLimiter = new RateLimiter({
    rateLimitPerMin: Number(env['AI_API_RATE_LIMIT_PER_MIN'] ?? '60'),
  });
  initializeRateLimiter(rateLimiter);
  rateLimiter.registerProject(String(validated.projectId));

  // GitLab APIベースURLを環境変数から取得（CI環境では CI_API_V4_URL を使用）
  const gitlabApiBaseUrl =
    env['GITLAB_API_URL'] ?? env['CI_API_V4_URL'] ?? 'https://gitlab.com/api/v4';

  // ArtifactCache 設定を環境変数から取得
  const maxArtifactZipMb = Number(env['PIPELINE_REPORT_MAX_ARTIFACT_ZIP_MB'] ?? '50');
  const totalArtifactDiskMb = Number(env['PIPELINE_REPORT_TOTAL_ARTIFACT_DISK_MB'] ?? '500');

  const gitlabClient = new GitLabApiClient(gitlabApiBaseUrl, validated.gitlabToken);
  const pipelineGateway = new GitLabPipelineGateway(gitlabClient);
  const projectTreeGateway = new LocalProjectTreeGateway();
  const archiveReader = new YauzlArtifactArchiveReader();
  const cacheManager = new ArtifactCacheManager(pipelineGateway, {
    maxArtifactZipBytes: maxArtifactZipMb * 1024 * 1024,
    totalDiskBytes: totalArtifactDiskMb * 1024 * 1024,
  });
  const workflowRunner = new MastraPipelineAnalysisWorkflowRunner(mastra);
  const tokenCounter = new GptTokenCounter();

  const service = new PipelineAnalysisService(
    pipelineGateway,
    projectTreeGateway,
    workflowRunner,
    tokenCounter,
    archiveReader,
    cacheManager,
  );

  return {
    service,
    cleanup: () => {
      try {
        rateLimiter.unregisterProject(String(validated.projectId));
        rateLimiter.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * APIモード用のデフォルトDI。実体は PipelineReportApiClient を new するだけ。
 */
const defaultApiDeps: PipelineReportApiDeps = {
  createClient: (config) => new PipelineReportApiClient(config),
};

/**
 * 進捗イベントをログに整形出力する共通処理。
 */
function formatProgressLog(event: PipelineReportProgressEvent): {
  level: 'info' | 'warn' | 'error';
  message: string;
  extra: Record<string, unknown>;
} {
  // workflow 内部の詳細イベント（type=log の場合は level を尊重）
  if (event.workflow !== undefined) {
    if (event.workflow.type === 'log') {
      const level =
        event.workflow.level === 'error' || event.workflow.level === 'warn'
          ? event.workflow.level
          : 'info';
      return {
        level,
        message: event.workflow.message,
        extra: { status: event.status, workflow: event.workflow },
      };
    }
    if (event.workflow.type === 'retry') {
      return {
        level: 'warn',
        message: `Retrying pipeline analysis: ${event.workflow.reason} (attempt ${event.workflow.retryCount})`,
        extra: { status: event.status, workflow: event.workflow },
      };
    }
    // phase イベント
    return {
      level: 'info',
      message: `Workflow phase: ${event.workflow.phase}`,
      extra: { status: event.status, workflow: event.workflow },
    };
  }
  return {
    level: 'info',
    message: event.message ?? `Pipeline report progress: ${event.status}`,
    extra: { status: event.status },
  };
}

/**
 * pipeline-report サブコマンドのエントリポイント。
 * review の `src/cli/review/index.ts` と同等の構造に揃えている。
 */
export async function run(args: string[], runOptions: RunOptions = {}): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  let parsed: ReturnType<typeof parsePipelineReportArgs> | undefined;

  // 引数パース・ロガー初期化は try 外側で実行し、パース失敗時のエラーログに userId を含められるようにする
  try {
    parsed = parsePipelineReportArgs(args, env);
  } catch (error) {
    // パース失敗時は最小限のロガーを作って異常終了する
    initializeLogger({ userId: 'unknown', level: 'info', prettyPrint: true });
    const logger = getLogger();
    if (error instanceof Error) {
      logger.error(
        { err: error, userId: 'unknown' },
        'Pipeline report failed during argument parsing',
      );
    } else {
      logger.error({ userId: 'unknown' }, `Pipeline report failed: ${String(error)}`);
    }
    flushLogger();
    process.exit(1);
  }

  initializeLogger({
    userId: parsed.userId ?? 'unknown',
    level: parsed.logLevel,
    prettyPrint: parsed.prettyPrint,
  });

  const logger = getLogger();
  logger.info('pipeline-report started');

  // APIモード時にAPIサーバーから受領するrequestId。エラーログの相関キーとしてcatchブロックからも参照できるよう外側に宣言
  let apiRequestId: string | undefined;

  try {
    // 必須パラメータのバリデーション
    const validated = validateRequiredParams(parsed, env);

    // 設定ファイル読み込み（指定がなければ default）
    const settings = parsed.pipelineReportSettings
      ? parsePipelineReportSettings(fs.readFileSync(parsed.pipelineReportSettings, 'utf-8'))
      : PipelineReportSettings.default();

    // MAX_CONTEXT_LENGTH バリデーション
    const maxContextLengthEnv = env['MAX_CONTEXT_LENGTH'];
    let maxContextLength: number | null = null;
    if (maxContextLengthEnv !== undefined && maxContextLengthEnv !== '') {
      const n = Number(maxContextLengthEnv);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `Invalid MAX_CONTEXT_LENGTH: ${maxContextLengthEnv}. Must be a positive integer.`,
        );
      }
      maxContextLength = n;
    }

    // 結果ファイルのパスを解決（相対パスはcwd基準）
    const resultFilePath = path.resolve(parsed.resultFile);

    const localMode = isLocalMode(parsed, env);

    if (localMode) {
      // === ローカルモード ===
      const localDepsFactory = runOptions.localDepsFactory ?? defaultLocalDepsFactory;
      const deps = localDepsFactory({ parsed, validated, env });

      try {
        // プロジェクトディレクトリ: CI環境ではCI_PROJECT_DIR、ローカルではcwd
        const projectDir = env['CI_PROJECT_DIR'] ?? process.cwd();
        const openaiReasoningEffort = env['OPENAI_REASONING_EFFORT'] || null;

        const command = buildPipelineReportCommand(parsed, validated, {
          settings,
          projectDir,
          maxContextLength,
          openaiReasoningEffort,
          onProgress: (event) => {
            // PipelineAnalysisProgressEvent をそのままログに流す
            if (event.type === 'log') {
              const level =
                event.level === 'error' || event.level === 'warn' ? event.level : 'info';
              getLogger()[level]({ event }, event.message);
            } else if (event.type === 'retry') {
              getLogger().warn(
                { event },
                `Retrying pipeline analysis: ${event.reason} (attempt ${event.retryCount})`,
              );
            } else {
              getLogger().info({ event }, `Workflow phase: ${event.phase}`);
            }
          },
        });

        const result = await deps.service.analyze(command);

        // 結果ファイルへ書き込み（サービスは一時ファイルを使用するため、ユーザ指定パスに改めて保存）
        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        fs.writeFileSync(resultFilePath, result.report.content);

        logger.info(
          { resultFilePath, contentLength: result.report.content.length },
          'Pipeline report completed',
        );

        // 標準出力へもレポート本文を出す（CIログ一覧で確認できるようにする）
        process.stdout.write(result.report.content);

        // workflow失敗時は部分レポートを保存した上で異常終了する
        if (result.workflowFailed) {
          logger.warn('Pipeline analysis workflow failed; partial report has been saved');
          flushLogger();
          process.exit(1);
        }
      } finally {
        deps.cleanup();
      }
    } else {
      // === APIモード ===
      const apiDeps = runOptions.apiDeps ?? defaultApiDeps;
      const apiRequest = buildPipelineReportApiRequest(parsed, validated, settings);

      const client = apiDeps.createClient({
        baseUrl: validated.aikataApiUrl!,
        jwt: validated.aikataJwt ?? null,
      });

      const result = await client.run(apiRequest, {
        onProgress: (event) => {
          runWithLogContext({ requestId: apiRequestId }, () => {
            const formatted = formatProgressLog(event);
            getLogger()[formatted.level](formatted.extra, formatted.message);
          });
        },
        onRequestId: (receivedRequestId) => {
          apiRequestId = receivedRequestId;
          runWithLogContext({ requestId: apiRequestId }, () => {
            getLogger().info('Pipeline report API request accepted by server');
          });
        },
        onError: (err) => {
          runWithLogContext({ requestId: apiRequestId }, () => {
            getLogger().error({ err }, 'Pipeline report API reported an error');
          });
        },
      });

      // レスポンス受領後の処理（ファイル書き込み・完了ログ・stdout出力）を requestId バインディング下で実行
      await runWithLogContext({ requestId: apiRequestId }, () => {
        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        fs.writeFileSync(resultFilePath, result.reportContent);

        getLogger().info(
          {
            resultFilePath,
            contentLength: result.reportContent.length,
            completenessVerified: result.completenessVerified,
            completenessRetries: result.completenessRetries,
            targetJobCount: result.targetJobIds.length,
          },
          'Pipeline report completed',
        );

        process.stdout.write(result.reportContent);

        // workflow失敗時は部分レポートを保存した上で異常終了する
        if (result.workflowFailed) {
          getLogger().warn('Pipeline analysis workflow failed; partial report has been saved');
          flushLogger();
          process.exit(1);
        }
      });
    }

    flushLogger();
  } catch (error) {
    const userId = parsed?.userId ?? 'unknown';
    const errorBindings: Record<string, unknown> = { userId };
    if (apiRequestId) {
      errorBindings['requestId'] = apiRequestId;
    }
    if (error instanceof Error) {
      logger.error({ ...errorBindings, err: error }, 'Pipeline report failed');
    } else {
      logger.error(errorBindings, `Pipeline report failed: ${String(error)}`);
    }
    flushLogger();
    process.exit(1);
  }
}

export const pipelineReportCliModule: CliFeatureModule = {
  name: 'pipeline-report',
  description: 'Analyze a GitLab CI/CD pipeline and produce a single Markdown report.',
  run: (args: string[]) => run(args),
};

/**
 * テスト向け: 一意な一時ディレクトリパスを返すヘルパ。
 * CLI の result-file 未指定時は cwd 基準になるため、このヘルパは公開API ではなく
 * 将来の用途を見越した未使用エクスポート。現時点では参照していない。
 */
export function makeTempReportPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${randomUUID()}.md`);
}
