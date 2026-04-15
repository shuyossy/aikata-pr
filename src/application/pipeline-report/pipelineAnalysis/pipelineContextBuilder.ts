import type { Pipeline } from '../../../domain/pipeline-report/pipeline/index.js';
import type { Job } from '../../../domain/pipeline-report/job/index.js';
import type { ArtifactTree } from '../../../domain/pipeline-report/artifact/index.js';
import type { ArtifactCacheEntryStatus } from './ArtifactCacheManager.js';

/**
 * buildPipelineUserPrompt の入力パラメータ。
 */
export interface BuildPipelineUserPromptParams {
  pipeline: Pipeline;
  targetJobs: Job[];
  /** ジョブID -> ログ本文（圧縮済みを含む） */
  jobLogs: Map<number, string>;
  /** artifact zip のツリー（cachedジョブのみ入る想定） */
  artifactTrees: ArtifactTree[];
  /** 全対象ジョブのartifactキャッシュステータス */
  artifactCacheStatuses: Map<number, ArtifactCacheEntryStatus>;
  folderTree: string;
  folderTreeStripped: boolean;
  /** CI/CD ジョブ定義（merged YAML）。取得できなかった場合は null */
  mergedYaml: string | null;
}

/**
 * バイト数を人間が読みやすい単位に変換する。
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * duration を "MM:SS" 形式に整形する。null の場合は "-" を返す。
 */
function formatDuration(duration: number | null): string {
  if (duration === null) return '-';
  const seconds = Math.round(duration);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * 対象ジョブ一覧をMarkdownテーブルにレンダリングする。
 */
function renderJobsTable(targetJobs: Job[]): string {
  if (targetJobs.length === 0) {
    return '_No target jobs._';
  }
  const header = '| jobId | stage | name | status | duration |';
  const divider = '| --- | --- | --- | --- | --- |';
  const rows = targetJobs.map(
    (job) =>
      `| ${job.id} | ${job.stage} | ${job.name} | ${job.status} | ${formatDuration(job.duration)} |`,
  );
  return [header, divider, ...rows].join('\n');
}

/**
 * 各ジョブのログセクションを組み立てる。
 */
function renderJobLogs(targetJobs: Job[], jobLogs: Map<number, string>): string {
  if (targetJobs.length === 0) {
    return '_No target jobs._';
  }
  const sections = targetJobs.map((job) => {
    const header = `### Job #${job.id} "${job.name}" (${job.status})`;
    const log = jobLogs.get(job.id);
    const body = log === undefined ? '_(no log captured)_' : '```\n' + log + '\n```';
    return `${header}\n\n${body}`;
  });
  return sections.join('\n\n');
}

/**
 * アーティファクトのステータス文言を生成する。
 */
function renderArtifactStatus(status: ArtifactCacheEntryStatus | undefined): string | null {
  if (status === undefined) {
    return '_[artifact status unknown]_';
  }
  switch (status.kind) {
    case 'cached':
      // cached はここでは文言を返さず呼び出し側でツリーを展開する
      return null;
    case 'no-artifacts':
      return '_[no artifacts]_';
    case 'skipped-too-large':
      return `_[artifact zip too large: ${formatBytes(status.sizeBytes)}]_`;
    case 'skipped-disk-full':
      return `_[artifact skipped: disk quota exceeded (${formatBytes(status.sizeBytes)})]_`;
    case 'error':
      return `_[artifact fetch error: ${status.reason}]_`;
    default: {
      // 網羅性チェック
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * 1ジョブ分のアーティファクトセクション本文を組み立てる。
 */
function renderArtifactBodyForJob(
  job: Job,
  artifactTrees: ArtifactTree[],
  artifactCacheStatuses: Map<number, ArtifactCacheEntryStatus>,
): string {
  const status = artifactCacheStatuses.get(job.id);
  const statusText = renderArtifactStatus(status);
  if (statusText !== null) {
    return statusText;
  }
  // cached ステータス: artifactTreesから該当ジョブのツリーを探す
  const tree = artifactTrees.find((t) => t.jobId === job.id);
  if (tree === undefined || tree.entries.length === 0) {
    return '_[artifact zip is empty]_';
  }
  const lines = tree.entries
    .filter((e) => e.type === 'file')
    .map((e) => `- \`${e.path}\` (${formatBytes(e.size)})`);
  if (lines.length === 0) {
    return '_[artifact zip contains only directories]_';
  }
  return lines.join('\n');
}

/**
 * Artifact Paths セクション全体を組み立てる。
 */
function renderArtifactPaths(
  targetJobs: Job[],
  artifactTrees: ArtifactTree[],
  artifactCacheStatuses: Map<number, ArtifactCacheEntryStatus>,
): string {
  if (targetJobs.length === 0) {
    return '_No target jobs._';
  }
  const sections = targetJobs.map((job) => {
    const header = `#### Job #${job.id} "${job.name}"`;
    const body = renderArtifactBodyForJob(job, artifactTrees, artifactCacheStatuses);
    return `${header}\n\n${body}`;
  });
  return sections.join('\n\n');
}

/**
 * CI/CD Job Definitions セクションを組み立てる。
 * mergedYaml が null の場合は空文字列を返し、非 null の場合はコードブロックで提示する。
 */
function renderJobDefinitionsSection(mergedYaml: string | null): string {
  if (mergedYaml === null) {
    return '';
  }
  return `## CI/CD Job Definitions (merged YAML)

The following is the fully resolved CI/CD configuration. Use it to understand what each job is configured to do.

\`\`\`yaml
${mergedYaml}
\`\`\``;
}

/**
 * Source Code Paths セクションを組み立てる。
 */
function renderSourceCodePaths(folderTree: string, folderTreeStripped: boolean): string {
  const note = folderTreeStripped
    ? '_Note: file entries were stripped from the folder tree due to context length constraints. Only directory structure is shown below. Use workspace tools to inspect individual files._\n\n'
    : '';
  const body = folderTree.length > 0 ? '```\n' + folderTree + '\n```' : '_(empty)_';
  return `${note}${body}`;
}

/**
 * pipelineAnalysisAgent に渡すユーザプロンプトを組み立てる。
 *
 * セクション構成:
 * 1. Pipeline メタ情報
 * 2. Jobs 一覧（テーブル形式）
 * 3. Job Logs（各ジョブごと）
 * 4. Artifact Paths（非圧縮、ジョブごとにキャッシュステータスも表示）
 * 5. Source Code Paths（folderTree、stripped時は注釈付き）
 */
export function buildPipelineUserPrompt(params: BuildPipelineUserPromptParams): string {
  const {
    pipeline,
    targetJobs,
    jobLogs,
    artifactTrees,
    artifactCacheStatuses,
    folderTree,
    folderTreeStripped,
    mergedYaml,
  } = params;

  // Pipeline セクション
  const pipelineSection = [
    '## Pipeline',
    '',
    `- **projectId:** ${pipeline.projectId}`,
    `- **pipelineId:** ${pipeline.pipelineId}`,
    `- **ref:** \`${pipeline.ref}\``,
    `- **sha:** \`${pipeline.sha}\``,
    `- **status:** ${pipeline.status}`,
    `- **webUrl:** ${pipeline.webUrl}`,
  ].join('\n');

  // Jobs セクション
  const jobsSection = [
    `## Jobs (${targetJobs.length} analyzed)`,
    '',
    renderJobsTable(targetJobs),
  ].join('\n');

  // CI/CD Job Definitions セクション（条件付き）
  const jobDefinitionsSection = renderJobDefinitionsSection(mergedYaml);

  // Job Logs セクション
  const jobLogsSection = ['## Job Logs', '', renderJobLogs(targetJobs, jobLogs)].join('\n');

  // Artifact Paths セクション（非圧縮）
  const artifactPathsSection = [
    '## Artifact Paths (not compressed)',
    '',
    renderArtifactPaths(targetJobs, artifactTrees, artifactCacheStatuses),
  ].join('\n');

  // Source Code Paths セクション
  const sourceCodeSection = [
    '## Source Code Paths',
    '',
    renderSourceCodePaths(folderTree, folderTreeStripped),
  ].join('\n');

  const sections = [
    pipelineSection,
    jobsSection,
    ...(jobDefinitionsSection ? [jobDefinitionsSection] : []),
    jobLogsSection,
    artifactPathsSection,
    sourceCodeSection,
  ];
  return sections.join('\n\n');
}
