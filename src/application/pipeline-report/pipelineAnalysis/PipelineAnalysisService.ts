import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { AnalysisReport } from '../../../domain/pipeline-report/analysisReport/index.js';
import { ArtifactTree } from '../../../domain/pipeline-report/artifact/index.js';
import type { Pipeline } from '../../../domain/pipeline-report/pipeline/index.js';
import type { Job } from '../../../domain/pipeline-report/job/index.js';
import type { PipelineReportSettings } from '../../../domain/pipeline-report/pipelineReportSettings/index.js';
import type { PipelineGateway } from '../../shared/port/gateway/PipelineGateway.js';
import type { ProjectTreeGateway } from '../../shared/port/gateway/ProjectTreeGateway.js';
import type {
  PipelineAnalysisProgressEvent,
  PipelineAnalysisWorkflowRunner,
} from '../../shared/port/workflow/PipelineAnalysisWorkflowRunner.js';
import type { TokenCounter } from '../../shared/port/tokenCounter/TokenCounter.js';
import { getLogger } from '../../../lib/logger.js';
import type { ArtifactArchiveReader } from './ArtifactArchiveReader.js';
import type { ArtifactCacheEntryStatus, ArtifactCacheManager } from './ArtifactCacheManager.js';
import { compressJobLogsIfNeeded } from './JobLogCompressor.js';
import { OVERALL_REPORT_TEMPLATE } from './defaultReportFormat.js';
import { buildPipelineUserPrompt } from './pipelineContextBuilder.js';

/**
 * PipelineAnalysisService への入力コマンド
 */
export interface PipelineAnalyzeCommand {
  userId: string;
  projectId: number;
  pipelineId: number;
  /** レポート出力ジョブ自身のジョブID。filterJobs で除外するために使う。 */
  selfJobId: number | null;
  settings: PipelineReportSettings;
  projectDir: string;
  commentLanguage: string;
  skillsPaths: string[];
  aiConfig: {
    apiKey: string;
    endpointUrl: string;
    modelName: string;
    reasoningEffort: string | null;
  };
  /** コンテキスト長圧縮の上限（null の場合は圧縮しない） */
  maxContextLength: number | null;
  /** フォルダツリー走査の最大深度。undefined の場合は無制限（review機能と同じ扱い） */
  treeMaxDepth: number | undefined;
  options: {
    maxCompletenessRetries: number;
    skipCompletenessCheck: boolean;
  };
  /** 進捗イベントのコールバック */
  onProgress: (event: PipelineAnalysisProgressEvent) => void;
}

/**
 * PipelineAnalysisService の出力結果
 */
export interface PipelineAnalysisResult {
  report: AnalysisReport;
  targetJobs: Job[];
  pipeline: Pipeline;
  completenessVerified: boolean;
  completenessRetries: number;
  /** workflow が失敗したが部分レポートを回復した場合に true */
  workflowFailed: boolean;
  tokenStats: {
    compressed: boolean;
    folderTreeStripped: boolean;
    compressedJobIds: number[];
  };
}

/**
 * パイプライン分析ユースケースを実行するアプリケーションサービス。
 *
 * 主な責務:
 * - PipelineGateway から Pipeline / Job / Job trace を取得
 * - PipelineReportSettings.filterJobs で対象ジョブを絞り込み
 * - ArtifactCacheManager で artifacts zip を並列プリフェッチ
 * - ArtifactArchiveReader で zip 内容を ArtifactTree に変換
 * - ProjectTreeGateway でプロジェクトフォルダツリーを取得
 * - JobLogCompressor で閾値超過時にジョブログを段階的圧縮
 * - 一時ファイルに全体レポートテンプレートを書き込み
 * - PipelineAnalysisWorkflowRunner に処理を委譲
 * - 最終的な一時ファイルの内容を読み AnalysisReport として返却
 * - finally で ArtifactCacheManager.cleanup を必ず呼ぶ
 */
export class PipelineAnalysisService {
  constructor(
    private readonly pipelineGateway: PipelineGateway,
    private readonly projectTreeGateway: ProjectTreeGateway,
    private readonly workflowRunner: PipelineAnalysisWorkflowRunner,
    private readonly tokenCounter: TokenCounter,
    private readonly archiveReader: ArtifactArchiveReader,
    private readonly cacheManager: ArtifactCacheManager,
  ) {}

  async analyze(command: PipelineAnalyzeCommand): Promise<PipelineAnalysisResult> {
    // 一時ファイルパスを事前に生成（finallyでのクリーンアップのため try 外で宣言）
    const resultFilePath = join(
      os.tmpdir(),
      `aikata-pipeline-report-${command.projectId}-${command.pipelineId}-${Date.now()}.md`,
    );
    try {
      // Step 1: Pipeline メタ情報取得
      const pipeline = await this.pipelineGateway.getPipeline(
        command.projectId,
        command.pipelineId,
      );

      // Step 2: ジョブ一覧取得
      const allJobs = await this.pipelineGateway.getJobs(command.projectId, command.pipelineId, {
        includeRetried: false,
      });

      // Step 2b: CI/CD ジョブ定義（merged YAML）取得（失敗しても分析は続行する）
      const mergedYaml = await this.pipelineGateway.getMergedYaml(command.projectId, pipeline.sha);
      if (mergedYaml === null) {
        const logger = getLogger();
        logger.warn(
          { projectId: command.projectId, pipelineId: command.pipelineId },
          'Failed to fetch merged YAML for CI/CD job definitions; continuing without job definitions',
        );
      }

      // Step 3: 対象ジョブ絞り込み
      const targetJobs = command.settings.filterJobs(allJobs, command.selfJobId);

      // 対象ジョブが 0 件の場合は workflow 実行をスキップし最小レポートを返す
      if (targetJobs.length === 0) {
        return {
          report: AnalysisReport.of(''),
          targetJobs: [],
          pipeline,
          completenessVerified: true,
          completenessRetries: 0,
          workflowFailed: false,
          tokenStats: {
            compressed: false,
            folderTreeStripped: false,
            compressedJobIds: [],
          },
        };
      }

      // Step 4: 各対象ジョブのログを並列取得
      // 一部ジョブの取得に失敗しても分析全体を止めない（PBI「成功・失敗に関わらず
      // 全ジョブのレポート」要件）。失敗したジョブには placeholder 本文を入れて続行する。
      const traceResults = await Promise.allSettled(
        targetJobs.map((job) => this.pipelineGateway.getJobTrace(command.projectId, job.id)),
      );
      const originalJobLogs = new Map<number, string>();
      const logger = getLogger();
      for (const [index, job] of targetJobs.entries()) {
        const outcome = traceResults[index]!;
        if (outcome.status === 'fulfilled') {
          originalJobLogs.set(job.id, outcome.value);
        } else {
          const reason =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          logger.warn(
            { err: outcome.reason, jobId: job.id, jobName: job.name },
            'Failed to fetch job trace; using placeholder and continuing analysis',
          );
          originalJobLogs.set(job.id, `[aikata: failed to fetch job trace: ${reason}]`);
        }
      }

      // Step 5: artifacts zip を並列プリフェッチ
      const artifactCacheStatuses = await this.cacheManager.prefetchForJobs(
        command.projectId,
        targetJobs,
      );

      // Step 6: 各 zip を ArtifactTree に変換（失敗したジョブはスキップ）
      const artifactTrees = await this.buildArtifactTrees(targetJobs, artifactCacheStatuses);

      // Step 7: プロジェクトフォルダツリー取得
      const folderTree = await this.projectTreeGateway.getTree(command.projectDir, {
        maxDepth: command.treeMaxDepth,
      });

      // Step 8 + 9: ユーザプロンプト組み立て用クロージャ + 閾値超過時の圧縮
      const compression = this.compressJobLogsIfConfigured(
        command,
        pipeline,
        targetJobs,
        originalJobLogs,
        artifactTrees,
        artifactCacheStatuses,
        folderTree,
      );

      // Step 10: 一時ファイルにレポートテンプレートを書き込み（review機能と同パターン）
      fs.writeFileSync(resultFilePath, OVERALL_REPORT_TEMPLATE);

      // Step 11: workflow 実行
      let completenessVerified: boolean;
      let completenessRetries: number;
      let workflowFailed = false;
      try {
        const workflowResult = await this.workflowRunner.run({
          userId: command.userId,
          projectId: command.projectId,
          pipelineMeta: pipeline,
          targetJobs,
          jobLogsCompressed: compression.compressedJobLogs,
          omittedJobLogs: compression.omittedJobLogs,
          mergedYaml,
          artifactTrees,
          folderTree: compression.effectiveFolderTree,
          folderTreeStripped: compression.folderTreeStripped,
          overallTemplate: OVERALL_REPORT_TEMPLATE,
          jobReportFormat: command.settings.jobReportFormat,
          additionalInstructions: command.settings.additionalInstructions,
          commentLanguage: command.commentLanguage,
          skillsPaths: command.skillsPaths,
          resultFilePath,
          projectDir: command.projectDir,
          artifactCacheStatuses,
          maxCompletenessRetries: command.options.maxCompletenessRetries,
          skipCompletenessCheck: command.options.skipCompletenessCheck,
          aiConfig: command.aiConfig,
          onProgress: command.onProgress,
        });
        completenessVerified = workflowResult.completenessVerified;
        completenessRetries = workflowResult.completenessRetries;
      } catch (workflowError) {
        // workflow 失敗時: レポートファイルに進捗があれば部分レポートとして回復する
        if (this.hasReportProgress(resultFilePath)) {
          const logger = getLogger();
          logger.warn(
            { err: workflowError },
            'Pipeline analysis workflow failed but partial report is available; returning partial result',
          );
          completenessVerified = false;
          completenessRetries = 0;
          workflowFailed = true;
        } else {
          throw workflowError;
        }
      }

      // Step 12: 最終レポート本文を読み取り
      const reportContent = fs.readFileSync(resultFilePath, 'utf-8');

      // Step 13: 戻り値
      return {
        report: AnalysisReport.of(reportContent),
        targetJobs,
        pipeline,
        completenessVerified,
        completenessRetries,
        workflowFailed,
        tokenStats: {
          compressed: compression.compressed,
          folderTreeStripped: compression.folderTreeStripped,
          compressedJobIds: Array.from(compression.compressedJobIds),
        },
      };
    } finally {
      // finally: artifactキャッシュと一時ファイルのクリーンアップ
      await this.cacheManager.cleanup();
      this.cleanupTempFiles(resultFilePath);
    }
  }

  /**
   * cached ジョブの zip を ArtifactArchiveReader で展開し ArtifactTree に変換する。
   * zip パース失敗はログ出力はせず当該ジョブを除外して続行する（呼び出し側で error ステータス表示）。
   */
  private async buildArtifactTrees(
    targetJobs: Job[],
    artifactCacheStatuses: Map<number, ArtifactCacheEntryStatus>,
  ): Promise<ArtifactTree[]> {
    const trees: ArtifactTree[] = [];
    for (const job of targetJobs) {
      const status = artifactCacheStatuses.get(job.id);
      if (status?.kind !== 'cached') {
        continue;
      }
      const zipPath = this.cacheManager.getZipPath(job.id);
      if (zipPath === null) {
        continue;
      }
      try {
        const entries = await this.archiveReader.listEntries(zipPath);
        trees.push(ArtifactTree.of({ jobId: job.id, jobName: job.name, entries }));
      } catch {
        // zip 破損などの場合は空ツリーにせず配列から除外（プロンプト側で「unknown」相当表示）
        // 厳密には error ステータスとして積む設計もあるが、ArtifactCacheManager 側で cached
        // として記録済みのため、ここでは tree を載せないだけの best-effort に留める
      }
    }
    return trees;
  }

  /**
   * maxContextLength が指定されている場合のみ JobLogCompressor を呼び出す。
   * 指定されていない場合は圧縮せず原ログをそのまま返す。
   */
  private compressJobLogsIfConfigured(
    command: PipelineAnalyzeCommand,
    pipeline: Pipeline,
    targetJobs: Job[],
    originalJobLogs: Map<number, string>,
    artifactTrees: ArtifactTree[],
    artifactCacheStatuses: Map<number, ArtifactCacheEntryStatus>,
    folderTree: string,
  ): {
    compressed: boolean;
    compressedJobLogs: Map<number, string>;
    omittedJobLogs: Map<number, string>;
    folderTreeStripped: boolean;
    effectiveFolderTree: string;
    compressedJobIds: Set<number>;
  } {
    // プロンプトのトークン数推定用クロージャ
    const userPromptBuilder = (logs: Map<number, string>, ft: string): string =>
      buildPipelineUserPrompt({
        pipeline,
        targetJobs,
        jobLogs: logs,
        artifactTrees,
        artifactCacheStatuses,
        folderTree: ft,
        folderTreeStripped: false,
      });

    if (command.maxContextLength === null) {
      return {
        compressed: false,
        compressedJobLogs: new Map(originalJobLogs),
        omittedJobLogs: new Map(),
        folderTreeStripped: false,
        effectiveFolderTree: folderTree,
        compressedJobIds: new Set(),
      };
    }

    const result = compressJobLogsIfNeeded(
      userPromptBuilder,
      originalJobLogs,
      folderTree,
      this.tokenCounter,
      {
        maxContextLength: command.maxContextLength,
        thresholdRatio: 0.6,
        initialKeepPercent: 30,
        keepPercentStep: 5,
        minKeepPercent: 5,
      },
    );

    return {
      compressed: result.compressed,
      compressedJobLogs: result.compressedJobLogs,
      omittedJobLogs: result.omittedJobLogs,
      folderTreeStripped: result.folderTreeStripped,
      effectiveFolderTree: result.folderTreeStripped ? result.strippedFolderTree : folderTree,
      compressedJobIds: result.compressedJobIds,
    };
  }

  /**
   * レポートファイルに初期テンプレートからの進捗があるかを判定する。
   * ファイル内容が OVERALL_REPORT_TEMPLATE と異なればレポート作成が進捗したと見なす。
   */
  private hasReportProgress(resultFilePath: string): boolean {
    try {
      const content = fs.readFileSync(resultFilePath, 'utf-8');
      return content !== OVERALL_REPORT_TEMPLATE;
    } catch {
      return false;
    }
  }

  /**
   * 結果ファイルの一時ロックディレクトリをクリーンアップする。
   * 結果ファイル自体は呼び出し側（CLI）が参照するため残す。
   */
  private cleanupTempFiles(resultFilePath: string): void {
    try {
      fs.rmdirSync(`${resultFilePath}.lock`);
    } catch {
      /* ignore */
    }
  }
}
