import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import type { PipelineAnalysisAgentRequestContext } from '../../requestContext.js';
import type { TargetJobSummary } from '../../types.js';
import { Pipeline } from '../../../../domain/pipeline-report/pipeline/index.js';
import { Job } from '../../../../domain/pipeline-report/job/index.js';
import {
  buildInstructions,
  buildUserPrompt,
  createToolset,
  createWorkspaceFromContext,
  deriveStageOrder,
  pipelineAnalysisAgent,
} from '../pipelineAnalysisAgent.js';

/**
 * テスト用のPipelineAnalysisAgentRequestContextオブジェクトを生成するヘルパー
 */
function createTestContextObject(
  overrides: Partial<PipelineAnalysisAgentRequestContext> = {},
): PipelineAnalysisAgentRequestContext {
  const targetJobs: TargetJobSummary[] = overrides.targetJobs ?? [
    { id: 101, name: 'build', stage: 'build', status: 'success', duration: 42 },
    { id: 102, name: 'test', stage: 'test', status: 'failed', duration: 120 },
  ];
  return {
    userId: 'test-user',
    projectId: '1234',
    pipelineId: 9999,
    projectDir: '/test/project',
    aiApiKey: 'test-key',
    aiApiEndpointUrl: 'http://localhost',
    aiModelName: 'test-model',
    openaiReasoningEffort: undefined,
    targetJobs,
    overallTemplate: '# パイプライン分析レポート\n{{job-sections}}',
    jobReportFormat:
      '### ジョブ #<jobId> — `<jobName>` (<stage> / <status>)\n**AI 総合評価:** <以下の3つから1つだけ選ぶ: 「問題なし」「要注意」「問題あり」>',
    additionalInstructions: null,
    commentLanguage: 'Japanese',
    resultFilePath: '/tmp/pipeline-report.md',
    skillsPaths: [],
    folderTree: 'src/\n  index.ts',
    folderTreeStripped: false,
    omittedJobLogs: new Map<number, string>(),
    artifactCachePaths: new Map<number, string | null>(),
    artifactArchiveReader: overrides.artifactArchiveReader ?? {
      listEntries: async () => [],
      readFile: async () => ({ data: Buffer.from(''), truncated: false }),
    },
    hasImages: false,
    pendingImages: [],
    reportLockTimeoutMs: undefined,
    workspaceAvailable: true,
    mergedYaml: null,
    ...overrides,
  };
}

/**
 * RequestContextを生成するヘルパー
 */
function createTestRequestContext(
  overrides: Partial<PipelineAnalysisAgentRequestContext> = {},
): RequestContext<PipelineAnalysisAgentRequestContext> {
  const obj = createTestContextObject(overrides);
  const entries = Object.entries(obj) as Array<
    [keyof PipelineAnalysisAgentRequestContext, unknown]
  >;
  return new RequestContext<PipelineAnalysisAgentRequestContext>(
    entries.map(([k, v]) => [k, v]) as ConstructorParameters<
      typeof RequestContext<PipelineAnalysisAgentRequestContext>
    >[0],
  );
}

describe('buildInstructions', () => {
  it('CI/CDパイプライン分析専門家としての役割が含まれ、resultFilePathはプロンプトに含まれない', () => {
    const ctx = createTestRequestContext({ resultFilePath: '/tmp/report-xyz.md' });

    const result = buildInstructions(ctx);

    expect(result).toMatch(/CI\/CD pipeline analysis expert/);
    // Agent はツール経由でレポートにアクセスするため、パスはノイズとして除外
    expect(result).not.toContain('/tmp/report-xyz.md');
  });

  it('userプロンプトで提供される情報の一覧がRole Definitionに含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/pipeline metadata/);
    expect(result).toMatch(/jobs summary table/);
    expect(result).toMatch(/job's log output/i);
    expect(result).toMatch(/artifact file listings/);
    expect(result).toMatch(/source code folder tree/);
  });

  it('Missionセクションでレポートツール（get-report / write-report / patch-report）の用途が明記される', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/report file is maintained/);
    expect(result).toMatch(/get-report to read/);
    expect(result).toMatch(/write-report to replace/);
    expect(result).toMatch(/patch-report to edit/);
  });

  it('Missionセクションでuserメッセージに現状レポートが含まれる場合の指示がある', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/user message includes the current report state/i);
  });

  it('Report Structure として overallTemplate がコードブロックで提示される', () => {
    const ctx = createTestRequestContext({
      overallTemplate: 'UNIQUE_OVERALL_TEMPLATE_CONTENT',
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('Report Structure');
    expect(result).toContain('UNIQUE_OVERALL_TEMPLATE_CONTENT');
  });

  it('Per-Job Block Format として jobReportFormat がコードブロックで提示される', () => {
    const ctx = createTestRequestContext({
      jobReportFormat: 'UNIQUE_JOB_REPORT_FORMAT_CONTENT',
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('Per-Job Block Format');
    expect(result).toContain('UNIQUE_JOB_REPORT_FORMAT_CONTENT');
  });

  it('列挙型hintの値は必ず列挙値から選ぶルールが含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/enum/i);
    expect(result).toMatch(/rules.*job block/i);
  });

  it('対象ジョブが表形式で列挙される', () => {
    const ctx = createTestRequestContext({
      targetJobs: [
        { id: 1, name: 'lint', stage: 'check', status: 'success', duration: 10 },
        { id: 2, name: 'test-unit', stage: 'test', status: 'failed', duration: 60 },
        { id: 3, name: 'deploy', stage: 'deploy', status: 'success', duration: 30 },
      ],
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('Target Jobs');
    expect(result).toContain('lint');
    expect(result).toContain('test-unit');
    expect(result).toContain('deploy');
    // Markdownテーブルのヘッダーが入っていること
    expect(result).toMatch(/\|\s*jobId\s*\|/i);
  });

  it('ReActフレームワーク（Reason/Act/Observe）が含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toContain('REASON');
    expect(result).toContain('ACT');
    expect(result).toContain('OBSERVE');
    expect(result).toMatch(/ReAct/i);
  });

  it('品質ルール（成功でも疑う/evidence引用/捏造禁止）が含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    // 成功でも疑うこと
    expect(result).toMatch(/success.*still|even.*success|treat.*success/i);
    // 引用の徹底
    expect(result).toMatch(/cite|citation|quote/i);
    // 捏造禁止
    expect(result).toMatch(/fabricat|do not invent|do not make up/i);
  });

  it('常時利用可能なツールがtool catalogに列挙される', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toContain('write-report');
    expect(result).toContain('patch-report');
    expect(result).toContain('get-report');
    expect(result).toContain('get-artifact-content');
  });

  it('omittedJobLogs.size === 0 の場合、get-job-log-detail は tool catalogに含まれない', () => {
    const ctx = createTestRequestContext({ omittedJobLogs: new Map() });

    const result = buildInstructions(ctx);

    expect(result).not.toContain('get-job-log-detail');
  });

  it('omittedJobLogs.size > 0 の場合、get-job-log-detail がtool catalogに含まれる', () => {
    const ctx = createTestRequestContext({
      omittedJobLogs: new Map<number, string>([[101, 'omitted middle log']]),
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('get-job-log-detail');
  });

  it('hasImages=false の場合、readImageの説明は含まれない', () => {
    const ctx = createTestRequestContext({ hasImages: false });

    const result = buildInstructions(ctx);

    expect(result).not.toContain('read-image');
  });

  it('hasImages=true の場合、readImageの説明がtool catalogに含まれる', () => {
    const ctx = createTestRequestContext({ hasImages: true });

    const result = buildInstructions(ctx);

    expect(result).toContain('read-image');
  });

  it('omittedJobLogs空かつfolderTreeStripped=falseの場合、Compression Notesが含まれない', () => {
    const ctx = createTestRequestContext({
      omittedJobLogs: new Map(),
      folderTreeStripped: false,
    });

    const result = buildInstructions(ctx);

    expect(result).not.toContain('Compression Notes');
  });

  it('omittedJobLogs.size > 0 の場合、Compression NotesでgetJobLogDetail利用方法に言及', () => {
    const ctx = createTestRequestContext({
      omittedJobLogs: new Map<number, string>([[1, 'omitted']]),
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('Compression Notes');
    expect(result).toContain('get-job-log-detail');
    expect(result).toMatch(/aikata.*omitted/i);
  });

  it('folderTreeStripped=trueの場合、Compression Notesで folder tree strip が言及される', () => {
    const ctx = createTestRequestContext({ folderTreeStripped: true });

    const result = buildInstructions(ctx);

    expect(result).toContain('Compression Notes');
    expect(result).toMatch(/folder tree/i);
    expect(result).toMatch(/strip/i);
  });

  it('additionalInstructionsがnullの場合、User-Specified Instructionsセクションは含まれない', () => {
    const ctx = createTestRequestContext({ additionalInstructions: null });

    const result = buildInstructions(ctx);

    expect(result).not.toContain('User-Specified Instructions');
    expect(result).not.toContain('HIGHEST PRIORITY');
  });

  it('additionalInstructionsが指定された場合、該当セクションがmission直後に挿入される', () => {
    const ctx = createTestRequestContext({
      additionalInstructions: 'FOCUS_ON_SECURITY_TESTS_XYZ',
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('FOCUS_ON_SECURITY_TESTS_XYZ');
    expect(result).toContain('HIGHEST PRIORITY');
    // Missionセクションよりは後、Report Structureより前（最優先として先頭付近に挿入）
    const missionIdx = result.indexOf('Mission');
    const instructionIdx = result.indexOf('FOCUS_ON_SECURITY_TESTS_XYZ');
    const reportStructureIdx = result.indexOf('Report Structure');
    expect(missionIdx).toBeGreaterThanOrEqual(0);
    expect(instructionIdx).toBeGreaterThan(missionIdx);
    expect(instructionIdx).toBeLessThan(reportStructureIdx);
  });

  it('commentLanguage=Japaneseの場合、writing constraintsで Japanese が参照される', () => {
    const ctx = createTestRequestContext({ commentLanguage: 'Japanese' });

    const result = buildInstructions(ctx);

    expect(result).toMatch(/write.*Japanese|report.*Japanese|Japanese/);
  });

  it('commentLanguage=Englishの場合、writing constraintsで English が参照される', () => {
    const ctx = createTestRequestContext({ commentLanguage: 'English' });

    const result = buildInstructions(ctx);

    expect(result).toMatch(/write.*English|report.*English/);
  });

  it('writing constraintsで引用の短縮とコードブロックで全体を囲まないことが言及される', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/short.*quote|keep.*citation.*short|quote.*brief/i);
    expect(result).toMatch(/not.*wrap.*entire|do not wrap/i);
  });

  it('全ての対象ジョブについて完成させる指示が含まれる（Finishing instructions）', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/all.*target jobs|every target job|MUST.*complete/i);
  });

  it('Missionセクションでレポートをtoolで書くことが警告付きで強制される', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toContain('WARNING');
    expect(result).toMatch(/MUST write all report content using the report tools/);
    expect(result).toMatch(/Never output report content as plain text/);
  });

  it('REASONセクションでアーティファクト調査の指示が含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/open key artifacts with get-artifact-content/);
  });

  it('REASONセクションでコードベース調査の指示が含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/reading project source code/);
    expect(result).toMatch(/recommended actions/);
  });

  it('Writing Constraintsでプレーンテキストでのレポート出力が禁止される', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/Never write report content as plain conversation text/);
    expect(result).toMatch(/must go through write-report or patch-report/);
  });

  it('最小構成（省略なし・画像なし・追加指示なし）: 条件付きセクションが全て省かれる', () => {
    const ctx = createTestRequestContext({
      omittedJobLogs: new Map(),
      hasImages: false,
      folderTreeStripped: false,
      additionalInstructions: null,
    });

    const result = buildInstructions(ctx);

    expect(result).not.toContain('get-job-log-detail');
    expect(result).not.toContain('read-image');
    expect(result).not.toContain('Compression Notes');
    expect(result).not.toContain('HIGHEST PRIORITY');
  });

  it('workspaceAvailable=true の場合、Workspace Toolsセクションが構造化バレットリスト形式で含まれる', () => {
    const ctx = createTestRequestContext({ workspaceAvailable: true });

    const result = buildInstructions(ctx);

    expect(result).toContain('Workspace Tools');
    // review機能と同等の構造化バレットリスト
    expect(result).toMatch(/File reading/);
    expect(result).toMatch(/Directory listing/);
    expect(result).toMatch(/File search/);
    expect(result).toMatch(/Sandbox commands/);
    // folder tree への言及
    expect(result).toMatch(/folder tree provided in the user message/i);
    expect(result).toContain('The workspace root is the project repository root directory.');
  });

  it('workspaceAvailable=false の場合、Workspace Toolsセクションが含まれない', () => {
    const ctx = createTestRequestContext({ workspaceAvailable: false });

    const result = buildInstructions(ctx);

    expect(result).not.toContain('Workspace Tools');
    // read-image は workspace 由来なので hasImages=true でも workspace 無効時は言及しない
    expect(result).not.toContain('read-image');
  });

  it('hasImages=true かつ workspaceAvailable=false の場合、read-imageには触れずget-artifact-contentだけを案内する', () => {
    const ctx = createTestRequestContext({
      hasImages: true,
      workspaceAvailable: false,
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('Image Handling');
    expect(result).toContain('get-artifact-content');
    expect(result).not.toContain('read-image');
    expect(result).toMatch(/staged for visual analysis/);
  });

  it('hasImages=true かつ workspaceAvailable=true の場合、read-imageによるソースツリー画像参照も案内される', () => {
    const ctx = createTestRequestContext({
      hasImages: true,
      workspaceAvailable: true,
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('Image Handling');
    expect(result).toContain('read-image');
  });

  it('mergedYaml=null の場合、CI/CD Job Definitions セクションが含まれない', () => {
    const ctx = createTestRequestContext({ mergedYaml: null });

    const result = buildInstructions(ctx);

    expect(result).not.toContain('CI/CD Job Definitions');
  });

  it('mergedYaml が指定された場合、CI/CD Job Definitions セクションが YAML コードブロック付きで含まれる', () => {
    const yaml = 'stages:\n  - build\n  - test\njob1:\n  script: echo hello\n';
    const ctx = createTestRequestContext({ mergedYaml: yaml });

    const result = buildInstructions(ctx);

    expect(result).toContain('CI/CD Job Definitions');
    expect(result).toContain(yaml);
    expect(result).toContain('```yaml');
  });

  it('mergedYaml が指定された場合、Role Definition に job definitions が含まれる', () => {
    const ctx = createTestRequestContext({ mergedYaml: 'stages:\n  - build\n' });

    const result = buildInstructions(ctx);

    expect(result).toMatch(/CI\/CD job definitions/i);
  });

  it('mergedYaml が指定された場合、CI/CD Job Definitions セクションは Target Jobs の後、Reasoning Framework の前に配置される', () => {
    const ctx = createTestRequestContext({ mergedYaml: 'stages:\n  - build\n' });

    const result = buildInstructions(ctx);

    const targetJobsIdx = result.indexOf('Target Jobs');
    const jobDefsIdx = result.indexOf('CI/CD Job Definitions');
    const reactIdx = result.indexOf('Reasoning Framework');
    expect(targetJobsIdx).toBeGreaterThanOrEqual(0);
    expect(jobDefsIdx).toBeGreaterThan(targetJobsIdx);
    expect(jobDefsIdx).toBeLessThan(reactIdx);
  });

  it('folderTreeStripped=true かつ workspaceAvailable=false の場合、workspace tools への言及は含まれない', () => {
    const ctx = createTestRequestContext({
      folderTreeStripped: true,
      workspaceAvailable: false,
    });

    const result = buildInstructions(ctx);

    expect(result).toContain('Compression Notes');
    expect(result).toMatch(/stripped|strip/i);
    expect(result).not.toContain('Workspace Tools');
  });
});

describe('buildUserPrompt', () => {
  it('pipelineContextBuilderへパラメータが正しく委譲される', () => {
    const ctx = createTestRequestContext({
      projectId: '111',
      pipelineId: 222,
      folderTree: 'SRC_TREE_MARKER',
      folderTreeStripped: true,
    });
    const pipeline = Pipeline.of({
      projectId: 111,
      pipelineId: 222,
      ref: 'main',
      sha: 'abc123',
      status: 'failed',
      webUrl: 'https://gitlab.example.com/pipelines/222',
      createdAt: new Date('2026-04-11T09:00:00Z'),
      updatedAt: new Date('2026-04-11T09:10:00Z'),
    });
    const targetJobs = [
      Job.of({
        id: 10,
        name: 'job-alpha',
        stage: 'build',
        status: 'success',
        startedAt: new Date('2026-04-11T09:01:00Z'),
        finishedAt: new Date('2026-04-11T09:02:00Z'),
        duration: 60,
        webUrl: 'https://example.com/jobs/10',
        failureReason: null,
        hasArtifacts: false,
        artifactsSize: 0,
      }),
    ];
    const jobLogs = new Map<number, string>([[10, 'LOG_BODY_MARKER']]);

    const result = buildUserPrompt(ctx, {
      pipeline,
      targetJobs,
      jobLogs,
      artifactTrees: [],
      artifactCacheStatuses: new Map(),
    });

    // Pipelineメタ情報、ジョブ、ログ、folder tree が含まれる
    expect(result).toContain('222');
    expect(result).toContain('job-alpha');
    expect(result).toContain('LOG_BODY_MARKER');
    expect(result).toContain('SRC_TREE_MARKER');
    // folderTreeStripped=true の注記
    expect(result).toMatch(/stripped|strip/i);
  });
});

describe('createToolset', () => {
  it('最小構成では4つのベースツール（write/patch/get/getArtifact）を返す', () => {
    const ctx = createTestContextObject({
      omittedJobLogs: new Map(),
      hasImages: false,
    });

    const tools = createToolset(ctx);

    expect(Object.keys(tools).sort()).toEqual(
      ['getArtifactContent', 'getReport', 'patchReport', 'writeReport'].sort(),
    );
  });

  it('omittedJobLogs.size > 0 の場合、getJobLogDetailが追加される', () => {
    const ctx = createTestContextObject({
      omittedJobLogs: new Map<number, string>([[1, 'omitted']]),
      hasImages: false,
    });

    const tools = createToolset(ctx);

    expect(Object.keys(tools)).toContain('getJobLogDetail');
    expect(Object.keys(tools)).toHaveLength(5);
  });

  it('hasImages=true の場合、readImageが追加される', () => {
    const ctx = createTestContextObject({ hasImages: true });

    const tools = createToolset(ctx);

    expect(Object.keys(tools)).toContain('readImage');
    expect(Object.keys(tools)).toHaveLength(5);
  });

  it('hasImages=false の場合、readImageは追加されない', () => {
    const ctx = createTestContextObject({ hasImages: false });

    const tools = createToolset(ctx);

    expect(Object.keys(tools)).not.toContain('readImage');
  });

  it('hasImages=true かつ omittedJobLogs.size > 0 の場合、readImageとgetJobLogDetailの両方が追加される', () => {
    const ctx = createTestContextObject({
      hasImages: true,
      omittedJobLogs: new Map<number, string>([[1, 'omitted']]),
    });

    const tools = createToolset(ctx);

    expect(Object.keys(tools)).toContain('readImage');
    expect(Object.keys(tools)).toContain('getJobLogDetail');
    expect(Object.keys(tools)).toHaveLength(6);
  });
});

describe('pipelineAnalysisAgent', () => {
  it('正しいIDと名前が設定されている', () => {
    expect(pipelineAnalysisAgent.id).toBe('pipeline-analysis-agent');
    expect(pipelineAnalysisAgent.name).toBe('Pipeline Analysis Agent');
  });
});

// buildUserPromptのpipelineContextBuilderへの委譲が確実に行われていることを確認する結合テスト
describe('buildUserPrompt (integration)', () => {
  it('空の対象ジョブでも例外が出ない', () => {
    const ctx = createTestRequestContext({ targetJobs: [] });
    const pipeline = Pipeline.of({
      projectId: 1,
      pipelineId: 2,
      ref: 'main',
      sha: 'deadbeef',
      status: 'success',
      webUrl: 'https://example.com/p/1/pipelines/2',
      createdAt: new Date('2026-04-11T09:00:00Z'),
      updatedAt: new Date('2026-04-11T09:05:00Z'),
    });
    expect(() =>
      buildUserPrompt(ctx, {
        pipeline,
        targetJobs: [],
        jobLogs: new Map(),
        artifactTrees: [],
        artifactCacheStatuses: new Map(),
      }),
    ).not.toThrow();
  });
});

describe('createWorkspaceFromContext', () => {
  it('projectDirをbasePath/workingDirectoryとしてWorkspaceを生成する', () => {
    const ctx = createTestContextObject({ projectDir: '/test/project' });
    const workspace = createWorkspaceFromContext(ctx);
    expect(workspace).toBeDefined();
  });

  it('skillsPathsが空配列の場合でもWorkspaceを生成できる', () => {
    const ctx = createTestContextObject({ skillsPaths: [] });
    const workspace = createWorkspaceFromContext(ctx);
    expect(workspace).toBeDefined();
  });

  it('skillsPathsが指定された場合でもWorkspaceを生成できる', () => {
    const ctx = createTestContextObject({ skillsPaths: ['/path/to/skills'] });
    const workspace = createWorkspaceFromContext(ctx);
    expect(workspace).toBeDefined();
  });

  it('WORKSPACE_TOOLS_CONFIGがWorkspaceに設定される', () => {
    const ctx = createTestContextObject({ projectDir: '/test/project' });
    const workspace = createWorkspaceFromContext(ctx);
    const toolsConfig = workspace.getToolsConfig();
    expect(toolsConfig).toBeDefined();
    expect(toolsConfig?.mastra_workspace_read_file?.maxOutputTokens).toBe(4000);
    expect(toolsConfig?.mastra_workspace_grep?.maxOutputTokens).toBe(3000);
    expect(toolsConfig?.mastra_workspace_list_files?.maxOutputTokens).toBe(2000);
    expect(toolsConfig?.mastra_workspace_execute_command?.maxOutputTokens).toBe(4000);
  });
});

describe('deriveStageOrder', () => {
  it('ジョブID昇順でユニークなステージ名を初出順に返す', () => {
    const jobs: TargetJobSummary[] = [
      { id: 3, name: 'deploy', stage: 'deploy', status: 'success', duration: 30 },
      { id: 1, name: 'lint', stage: 'check', status: 'success', duration: 10 },
      { id: 2, name: 'test-unit', stage: 'test', status: 'failed', duration: 60 },
    ];

    const result = deriveStageOrder(jobs);

    expect(result).toEqual(['check', 'test', 'deploy']);
  });

  it('同一ステージに複数ジョブがある場合、最小IDで順序を決定する', () => {
    const jobs: TargetJobSummary[] = [
      { id: 10, name: 'test-e2e', stage: 'test', status: 'success', duration: 120 },
      { id: 5, name: 'build-app', stage: 'build', status: 'success', duration: 42 },
      { id: 7, name: 'test-unit', stage: 'test', status: 'failed', duration: 60 },
      { id: 6, name: 'build-lib', stage: 'build', status: 'success', duration: 30 },
    ];

    const result = deriveStageOrder(jobs);

    expect(result).toEqual(['build', 'test']);
  });

  it('空配列の場合は空配列を返す', () => {
    const result = deriveStageOrder([]);

    expect(result).toEqual([]);
  });

  it('単一ステージの場合はそのステージ名のみを返す', () => {
    const jobs: TargetJobSummary[] = [
      { id: 1, name: 'test-a', stage: 'test', status: 'success', duration: 10 },
      { id: 2, name: 'test-b', stage: 'test', status: 'failed', duration: 20 },
    ];

    const result = deriveStageOrder(jobs);

    expect(result).toEqual(['test']);
  });

  it('元の配列を変更しない', () => {
    const jobs: TargetJobSummary[] = [
      { id: 3, name: 'deploy', stage: 'deploy', status: 'success', duration: 30 },
      { id: 1, name: 'lint', stage: 'check', status: 'success', duration: 10 },
    ];
    const originalOrder = [...jobs];

    deriveStageOrder(jobs);

    expect(jobs).toEqual(originalOrder);
  });
});

describe('buildInstructions - Job Section Ordering', () => {
  it('Job Section Orderingセクションが含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toContain('Job Section Ordering');
  });

  it('評価が悪い順にソートする指示が含まれる', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    expect(result).toMatch(/sever|important|problematic/i);
    expect(result).toMatch(/order|sort/i);
  });

  it('ステージ実行順が明示的に列挙される', () => {
    const ctx = createTestRequestContext({
      targetJobs: [
        { id: 1, name: 'lint', stage: 'check', status: 'success', duration: 10 },
        { id: 2, name: 'test-unit', stage: 'test', status: 'failed', duration: 60 },
        { id: 3, name: 'deploy', stage: 'deploy', status: 'success', duration: 30 },
      ],
    });

    const result = buildInstructions(ctx);

    // ステージ順が具体的に列挙されている
    expect(result).toContain('check');
    expect(result).toContain('test');
    expect(result).toContain('deploy');
  });

  it('Job Section OrderingはRules for Job Blocksの後、Target Jobsの前に配置される', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    const rulesIdx = result.indexOf('Rules for Job Blocks');
    const orderingIdx = result.indexOf('Job Section Ordering');
    const targetJobsIdx = result.indexOf('Target Jobs');
    expect(rulesIdx).toBeGreaterThanOrEqual(0);
    expect(orderingIdx).toBeGreaterThan(rulesIdx);
    expect(orderingIdx).toBeLessThan(targetJobsIdx);
  });

  it('Finishing Instructionsに順序確認の言及がある', () => {
    const ctx = createTestRequestContext();

    const result = buildInstructions(ctx);

    // Finishing Instructionsセクション内に順序に関する言及
    const finishingIdx = result.indexOf('Finishing Instructions');
    const afterFinishing = result.substring(finishingIdx);
    expect(afterFinishing).toMatch(/order/i);
  });
});
