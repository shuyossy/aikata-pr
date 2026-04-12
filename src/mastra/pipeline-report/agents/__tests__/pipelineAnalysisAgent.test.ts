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
    projectId: 1234,
    pipelineId: 9999,
    projectDir: '/test/project',
    aiConfig: {
      apiKey: 'test-key',
      endpointUrl: 'http://localhost',
      modelName: 'test-model',
      reasoningEffort: null,
    },
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
    hasImages: false,
    pendingImages: new Map(),
    reportLockTimeoutMs: undefined,
    workspaceAvailable: true,
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
  it('CI/CDパイプライン分析専門家としての役割と resultFilePath のミッションが含まれる', () => {
    const ctx = createTestRequestContext({ resultFilePath: '/tmp/report-xyz.md' });

    const result = buildInstructions(ctx);

    expect(result).toMatch(/CI\/CD pipeline analysis expert/);
    expect(result).toContain('/tmp/report-xyz.md');
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

  it('workspaceAvailable=true の場合、Workspace Toolsセクションが含まれる', () => {
    const ctx = createTestRequestContext({ workspaceAvailable: true });

    const result = buildInstructions(ctx);

    expect(result).toContain('Workspace Tools');
    expect(result).toMatch(/workspace tools|sandboxed commands/i);
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
      projectId: 111,
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

  it('hasImages=trueでも、Phase 8時点ではreadImageは追加されない（workspace tool導入対象外）', () => {
    // 注: 設計書では readImage を Phase 9 の workflow 層で workspace tools と一緒に統合予定。
    // Phase 8 ではツールセットに readImage を含めず、systemプロンプトの説明のみに留める。
    const ctx = createTestContextObject({ hasImages: true });

    const tools = createToolset(ctx);

    expect(Object.keys(tools)).not.toContain('readImage');
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
