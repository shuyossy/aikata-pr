import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import type { PipelineAnalysisAgentRequestContext } from '../requestContext.js';
import type { TargetJobSummary } from '../types.js';
import type { Pipeline } from '../../../domain/pipeline-report/pipeline/index.js';
import type { Job } from '../../../domain/pipeline-report/job/index.js';
import type { ArtifactTree } from '../../../domain/pipeline-report/artifact/index.js';
import {
  buildPipelineUserPrompt,
  type BuildPipelineUserPromptParams,
} from '../../../application/pipeline-report/pipelineAnalysis/pipelineContextBuilder.js';
import type { ArtifactCacheEntryStatus } from '../../../application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.js';
import { writeReportTool } from '../tools/writeReport.js';
import { patchReportTool } from '../tools/patchReport.js';
import { getReportTool } from '../tools/getReport.js';
import { getJobLogDetailTool } from '../tools/getJobLogDetail.js';
import { getArtifactContentTool } from '../tools/getArtifactContent.js';
import { readImageTool } from '../../review/tools/readImage.js';
import { createModelFromContext } from '../../shared/requestContext.js';

/**
 * pipelineAnalysisAgent 用のツールセット型
 * 常時登録されるツールに加え、条件付きでgetJobLogDetail / readImageが登録される
 */
export type PipelineAnalysisAgentToolSet = {
  writeReport: typeof writeReportTool;
  patchReport: typeof patchReportTool;
  getReport: typeof getReportTool;
  getArtifactContent: typeof getArtifactContentTool;
  getJobLogDetail?: typeof getJobLogDetailTool;
  readImage?: typeof readImageTool;
};

/**
 * 対象ジョブ一覧を Markdown テーブルにレンダリングする
 * 設計書 §6.1 "Target Jobs" セクションで使用
 */
function renderTargetJobsTable(jobs: TargetJobSummary[]): string {
  if (jobs.length === 0) {
    return '_(no target jobs)_';
  }
  const header = '| jobId | stage | name | status |';
  const divider = '| --- | --- | --- | --- |';
  const rows = jobs.map((job) => `| ${job.id} | ${job.stage} | ${job.name} | ${job.status} |`);
  return [header, divider, ...rows].join('\n');
}

/**
 * additionalInstructions セクションを組み立てる
 * null の場合は空文字列を返し、non-null の場合は最優先セクションとして挿入する
 */
function renderAdditionalInstructionsSection(additional: string | null): string {
  if (additional === null || additional.trim() === '') {
    return '';
  }
  return `## User-Specified Instructions (HIGHEST PRIORITY)

The following instructions were provided by the user. You MUST follow them with the highest priority, even when they appear to conflict with the guidance below.

${additional}

`;
}

/**
 * Tool Catalog セクションを組み立てる
 * 常時登録ツールに加え、omittedJobLogs / hasImages の状況に応じて説明を追加する
 */
function renderToolCatalog(ctx: PipelineAnalysisAgentRequestContext): string {
  const lines: string[] = [];
  lines.push('## Tool Catalog');
  lines.push('');
  lines.push(
    'You have access to the following tools. Reason about which one to call next, and always state the reason before calling a tool.',
  );
  lines.push('');
  lines.push('### Report Writing Tools');
  lines.push(
    '- **write-report**: Replace the entire contents of the report file with a new value. Use this only for the initial skeleton or a full rewrite — prefer patch-report for incremental updates because it is cheaper and less error-prone.',
  );
  lines.push(
    '- **patch-report**: Replace a unique `oldString` inside the report file with `newString`. This is the primary way to fill a job block. If `oldString` is not unique, the tool returns an error — provide more surrounding context and retry.',
  );
  lines.push(
    '- **get-report**: Read the current contents of the report file. Call this before patch-report whenever you are uncertain about the exact text you will target.',
  );
  lines.push('');
  lines.push('### Evidence Gathering Tools');
  lines.push(
    "- **get-artifact-content**: Read a specific file from a job's artifact zip by `jobId` + `artifactPath`. Text files are returned as UTF-8 text (possibly truncated). Supported image files (PNG/JPEG/GIF/WebP) are staged for visual analysis — the image content is appended as a separate user message on the next turn, so you can see it. Unsupported binary files are reported as such.",
  );

  if (ctx.omittedJobLogs.size > 0) {
    lines.push(
      '- **get-job-log-detail**: Retrieve the omitted middle portion of a compressed job log. Only some jobs were compressed (see Compression Notes below). Call this whenever you need the full details of a specific compressed job.',
    );
  }

  if (ctx.hasImages) {
    lines.push('');
    lines.push('### Image Handling');
    if (ctx.workspaceAvailable) {
      lines.push(
        '- When get-artifact-content returns a supported image, its data is delivered as a separate user message on the next turn. Use that visual information to support your analysis of the owning job. Never fabricate image contents — if you did not actually receive an image turn, do not claim to have seen it.',
      );
      lines.push(
        '- If you are inspecting image files that live in the project source tree (not in artifacts), use the workspace **read-image** capability instead of get-artifact-content.',
      );
    } else {
      lines.push(
        '- When get-artifact-content returns a supported image, its data is delivered as a separate user message on the next turn. Use that visual information to support your analysis of the owning job. Never fabricate image contents — if you did not actually receive an image turn, do not claim to have seen it.',
      );
      lines.push(
        '- Project source tree images are not directly accessible in this run. Limit image analysis to artifacts retrieved via get-artifact-content.',
      );
    }
  }

  if (ctx.workspaceAvailable) {
    lines.push('');
    lines.push('### Workspace Tools');
    lines.push(
      'You also have access to workspace tools for reading source files, listing directories, and running sandboxed commands inside the project repository. Use them when the job log or artifacts alone are not enough to understand what a job did — for example, when you need to look at the failing test file or the build script referenced in a log line.',
    );
    lines.push('The workspace root is the project repository root directory.');
  }
  return lines.join('\n');
}

/**
 * Compression Notes セクションを組み立てる
 * omittedJobLogs.size > 0 または folderTreeStripped=true の時のみ出力
 */
function renderCompressionNotes(ctx: PipelineAnalysisAgentRequestContext): string {
  const needsJobLogNote = ctx.omittedJobLogs.size > 0;
  const needsFolderTreeNote = ctx.folderTreeStripped;

  if (!needsJobLogNote && !needsFolderTreeNote) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## Compression Notes');
  lines.push('');

  if (needsJobLogNote) {
    lines.push(
      "Some job logs in the user prompt were compressed to fit within context limits. Compressed regions are marked with `[aikata: N lines omitted from middle]`. When you need the omitted middle portion for a specific job, call the **get-job-log-detail** tool with that job's id.",
    );
  }

  if (needsFolderTreeNote) {
    if (needsJobLogNote) {
      lines.push('');
    }
    if (ctx.workspaceAvailable) {
      lines.push(
        'The project folder tree has been **stripped** of individual file entries to save context space. Only directory structure remains. Use the workspace file listing and file reading tools to inspect actual files when you need to cross-reference a log line against real source code.',
      );
    } else {
      lines.push(
        'The project folder tree has been **stripped** of individual file entries to save context space. Only directory structure remains. Rely on job logs and artifacts for detailed source-level evidence in this run.',
      );
    }
  }

  return lines.join('\n');
}

/**
 * RequestContext から pipelineAnalysisAgent の system プロンプト（instructions）を組み立てる
 *
 * 設計書 §6.1 のテンプレートを条件分岐付きで構築する。セクション順序:
 * 1. Role definition
 * 2. Mission
 * 3. User-Specified Instructions (条件付き)
 * 4. Report Structure
 * 5. Per-Job Block Format
 * 6. Rules for Job Blocks
 * 7. Target Jobs
 * 8. ReAct Framework
 * 9. Quality Rules
 * 10. Tool Catalog (条件付き含む)
 * 11. Compression Notes (条件付き)
 * 12. Writing Constraints
 * 13. Finishing Instructions
 */
export function buildInstructions(
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>,
): string {
  const ctx = requestContext.all;
  const targetJobsTable = renderTargetJobsTable(ctx.targetJobs);
  const additionalSection = renderAdditionalInstructionsSection(ctx.additionalInstructions);
  const toolCatalog = renderToolCatalog(ctx);
  const compressionNotes = renderCompressionNotes(ctx);

  return `You are a CI/CD pipeline analysis expert. You analyze every target job in a GitLab CI pipeline and write a single consolidated analysis report. Think and reason in English; write the report content in ${ctx.commentLanguage}.

## Mission

Your mission is to produce a complete analysis report at: \`${ctx.resultFilePath}\`.

The report file already contains an empty skeleton. You are responsible for filling it in by combining the per-job evidence you gather via tools with the format defined below. When you are done, every target job listed later in this prompt must have its own per-job block inside the report, and the overall sections (summary, status breakdown, recommended actions) must also be completed.

${additionalSection}## Report Structure

The overall report skeleton is fixed. Fill in every placeholder (including the overall summary, status breakdown table, recommended actions, and the per-job section region) according to the template below:

\`\`\`
${ctx.overallTemplate}
\`\`\`

## Per-Job Block Format

Each target job MUST be rendered as a block that follows this format exactly. Placeholders are written in angle brackets (e.g. \`<jobId>\`, \`<duration>\`). Enum hints look like \`<choose one: "X" | "Y" | "Z">\` and require you to pick one of the listed values.

\`\`\`
${ctx.jobReportFormat}
\`\`\`

## Rules for Job Blocks

- Replace every placeholder \`<...>\` with a concrete, job-specific value. Do NOT leave any hint text verbatim in the final report.
- When a placeholder uses an enum hint, you MUST write exactly one of the listed enum values. Do not invent new values, do not translate the enum values, and do not add extra words inside the enum slot.
- Every block MUST contain all sections defined in the format above, in the same order.
- Every factual claim inside a block MUST be backed by a concrete citation (a log line, an artifact excerpt, or a source file path). Never fabricate evidence.

## Target Jobs

You must produce a block for every job in the following table:

${targetJobsTable}

## Reasoning Framework (ReAct)

For each target job, apply the Reason-Act-Observe cycle until you can confidently write its block:

**REASON**: Assess what you currently know about this job.
- What does the job log say?
- What does the job's artifact file list suggest?
- What does the report format require that you still lack evidence for?

**ACT**: Take one concrete step.
- If more evidence is needed: call one of the tools in the Tool Catalog. State why before calling.
- If you have enough evidence: write the block using patch-report (or write-report for the initial skeleton).

**OBSERVE**: Evaluate the result.
- Did the tool give you the information you needed? Did it raise new questions?
- After writing a block, re-read the report with get-report if you are unsure whether the patch landed correctly.

Before using any tool(s), explain to users the reasoning behind why you are using that tool(s).

## Quality Rules

- **Treat success with suspicion**: GitLab may mark a job as success while the log hides skipped tests, swallowed errors, or unexpected warnings. Always read the log for warning signs before concluding that a job is healthy.
- **Cite evidence**: Every problem you report must be tied to a specific log line, artifact file, or source location so a reader can verify the claim. Keep each citation brief (a single line or a short excerpt).
- **Never fabricate**: Do not invent log lines, artifact contents, or source code. If the evidence is not available, say so explicitly (e.g. "no artifact was available for this job") rather than making something up.
- **Be comprehensive but concise**: Cover every target job, but keep each block tight. Avoid restating the same finding in multiple sections.

${toolCatalog}

${compressionNotes ? `${compressionNotes}\n\n` : ''}## Writing Constraints

- Write the report content in **${ctx.commentLanguage}**. Only reason and plan internally in English.
- Keep citations short. Quote a single log line or a small excerpt rather than pasting a full log section.
- Do NOT wrap the entire report in a single outer code block. Use code blocks only for log lines, file paths, shell commands, or short code excerpts that genuinely benefit from monospace rendering.
- Use patch-report for incremental edits whenever possible. Reserve write-report for the initial template or a full rewrite.

## Finishing Instructions

You MUST produce a completed block for every target job listed above, and every section in the report skeleton must be filled in. Do NOT stop until all target jobs have been analyzed and their blocks have been written to the report file. Once you believe you are done, do a final get-report and verify every job block is present and every placeholder is resolved before ending your turn.`;
}

/**
 * pipelineAnalysisAgent の user プロンプトを組み立てる
 *
 * pipelineContextBuilder の buildPipelineUserPrompt をラップする。
 * RequestContext から folderTree / folderTreeStripped を取得し、
 * 呼び出し元から Pipeline / targetJobs / jobLogs / artifactTrees /
 * artifactCacheStatuses を受け取る。
 */
export interface BuildUserPromptInputs {
  pipeline: Pipeline;
  targetJobs: Job[];
  jobLogs: Map<number, string>;
  artifactTrees: ArtifactTree[];
  artifactCacheStatuses: Map<number, ArtifactCacheEntryStatus>;
}

export function buildUserPrompt(
  requestContext: RequestContext<PipelineAnalysisAgentRequestContext>,
  inputs: BuildUserPromptInputs,
): string {
  const ctx = requestContext.all;
  const params: BuildPipelineUserPromptParams = {
    pipeline: inputs.pipeline,
    targetJobs: inputs.targetJobs,
    jobLogs: inputs.jobLogs,
    artifactTrees: inputs.artifactTrees,
    artifactCacheStatuses: inputs.artifactCacheStatuses,
    folderTree: ctx.folderTree,
    folderTreeStripped: ctx.folderTreeStripped,
  };
  return buildPipelineUserPrompt(params);
}

/**
 * pipelineAnalysisAgent のツールセットを条件付きで組み立てるファクトリ
 *
 * - 常時登録: writeReport / patchReport / getReport / getArtifactContent
 * - omittedJobLogs.size > 0 のとき: getJobLogDetail を追加
 * - hasImages のとき: readImage を追加（review機能と同じツールを共用）
 */
export function createToolset(
  ctx: PipelineAnalysisAgentRequestContext,
): PipelineAnalysisAgentToolSet {
  const toolset: PipelineAnalysisAgentToolSet = {
    writeReport: writeReportTool,
    patchReport: patchReportTool,
    getReport: getReportTool,
    getArtifactContent: getArtifactContentTool,
  };
  if (ctx.omittedJobLogs.size > 0) {
    toolset.getJobLogDetail = getJobLogDetailTool;
  }
  if (ctx.hasImages) {
    toolset.readImage = readImageTool;
  }
  return toolset;
}

/**
 * pipelineAnalysisAgent 用メモリ
 *
 * review の reviewAgentMemory と同じ設計で lastMessages: 1000 を上限とする。
 * 長大なツール呼び出し列でもコンテキスト内で保持できるようにしつつ、
 * 無制限によるコンテキスト溢れを防止する。
 */
const pipelineAnalysisAgentMemory = new Memory({
  options: {
    lastMessages: 1000,
  },
});

/**
 * RequestContextからWorkspaceを生成するファクトリ関数。
 * プロジェクトディレクトリをbasePath/workingDirectoryとして設定し、
 * ユーザ指定のskillsパスを登録する。
 * filesystemはreadOnlyにすることで、分析時の意図しない書き込みを防ぐ。
 */
export function createWorkspaceFromContext(ctx: PipelineAnalysisAgentRequestContext): Workspace {
  return new Workspace({
    filesystem: new LocalFilesystem({
      basePath: ctx.projectDir,
      readOnly: true,
    }),
    sandbox: new LocalSandbox({
      workingDirectory: ctx.projectDir,
    }),
    skills: ctx.skillsPaths.length > 0 ? ctx.skillsPaths : undefined,
  });
}

/**
 * pipelineAnalysisAgent（シングルトン）
 *
 * パイプラインの各ジョブを解析し、resultFilePath の分析レポートを完成させる
 * メインのエージェント。モデル / instructions / tools / workspace は RequestContext から動的に決定される。
 */
export const pipelineAnalysisAgent = new Agent<
  'pipeline-analysis-agent',
  PipelineAnalysisAgentToolSet,
  undefined,
  PipelineAnalysisAgentRequestContext
>({
  id: 'pipeline-analysis-agent',
  name: 'Pipeline Analysis Agent',
  memory: pipelineAnalysisAgentMemory,
  model: ({ requestContext }) => {
    const ctx = requestContext.all as PipelineAnalysisAgentRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: ({ requestContext }) => {
    return buildInstructions(requestContext);
  },
  tools: ({ requestContext }) => {
    const ctx = requestContext.all as PipelineAnalysisAgentRequestContext;
    return createToolset(ctx);
  },
  workspace: ({ requestContext }) => {
    const ctx = requestContext?.all as PipelineAnalysisAgentRequestContext | undefined;
    if (!ctx?.projectDir) {
      return undefined;
    }
    if (!ctx.workspaceAvailable) {
      return undefined;
    }
    return createWorkspaceFromContext(ctx);
  },
});
