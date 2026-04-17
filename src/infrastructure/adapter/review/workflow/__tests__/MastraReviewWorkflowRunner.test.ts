import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewWorkflowParams } from '../../../../../application/shared/port/workflow/index.js';
import { MastraReviewWorkflowRunner } from '../MastraReviewWorkflowRunner.js';

// vi.hoistedでモック関数をvi.mockより先に初期化
const { mockStart, mockGetWorkflow } = vi.hoisted(() => {
  const mockStart = vi.fn().mockResolvedValue({
    status: 'success',
    result: { results: [], suggestions: [] },
  });
  const mockCreateRun = vi.fn().mockResolvedValue({ start: mockStart });
  const mockGetWorkflow = vi.fn().mockReturnValue({ createRun: mockCreateRun });
  return { mockStart, mockCreateRun, mockGetWorkflow };
});

// mastraモジュールをモック
vi.mock('../../../../../mastra/index.js', () => ({
  mastra: {
    getWorkflow: mockGetWorkflow,
  },
}));

// ヘルパー: テスト用のReviewWorkflowParamsを生成
function createParams(overrides?: Partial<ReviewWorkflowParams>): ReviewWorkflowParams {
  return {
    // RequestContextに分離される7フィールド
    userId: 'test-user',
    projectId: 'project-1',
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://api.example.com',
    aiModelName: 'openai/o4-mini',
    projectDir: '/test/project',
    openaiReasoningEffort: undefined,
    // InputDataに入る残りフィールド
    checkItemContents: ['可読性チェック', 'テストカバレッジ'],
    concurrentReviewCount: null,
    ratings: [
      { label: 'A', definition: '完全に満たしている' },
      { label: 'B', definition: '概ね満たしている' },
    ],
    commentFormat: '{comment}',
    additionalInstructions: 'Be thorough',
    mrTitle: 'Test MR',
    mrDescription: 'Test description',
    mrSourceBranch: 'feature/test',
    mrTargetBranch: 'main',
    mrDiff: '+ added line',
    mrCommitHash: 'abc123',
    priorReviewResults: null,
    priorCommitMessages: null,
    priorDiffSincePrior: null,
    skillsPaths: ['/path/to/skills'],
    resultFilePath: '/tmp/result.json',
    folderTree: 'src/\n  index.ts',
    commentLanguage: 'Japanese',
    omittedFileDiffs: null,
    allDiffFilePaths: null,
    diffCompressed: false,
    folderTreeRemovedByCompression: false,
    suggestEnabledRatingLabels: ['C'],
    suggestResultFilePath: '/tmp/suggest-result.json',
    fullMrDiff: '+ added line',
    ...overrides,
  };
}

describe('MastraReviewWorkflowRunner', () => {
  let runner: MastraReviewWorkflowRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new MastraReviewWorkflowRunner();
  });

  it('RequestContextに7フィールドが正しく設定されること', async () => {
    const params = createParams();

    await runner.run(params);

    expect(mockGetWorkflow).toHaveBeenCalledWith('reviewWorkflow');
    const startCall = vi.mocked(mockStart).mock.calls[0][0] as {
      inputData: Record<string, unknown>;
      requestContext: { get(key: string): unknown; all: Record<string, unknown> };
    };

    const ctx = startCall.requestContext;
    expect(ctx.get('userId')).toBe('test-user');
    expect(ctx.get('projectId')).toBe('project-1');
    expect(ctx.get('aiApiKey')).toBe('test-api-key');
    expect(ctx.get('aiApiEndpointUrl')).toBe('https://api.example.com');
    expect(ctx.get('aiModelName')).toBe('openai/o4-mini');
    expect(ctx.get('projectDir')).toBe('/test/project');
    expect(ctx.get('openaiReasoningEffort')).toBeUndefined();
  });

  it('InputDataにRequestContext以外の全フィールドが含まれること', async () => {
    const params = createParams();

    await runner.run(params);

    const startCall = vi.mocked(mockStart).mock.calls[0][0] as {
      inputData: Record<string, unknown>;
      requestContext: unknown;
    };
    const inputData = startCall.inputData;

    // InputDataに含まれるべきフィールド
    expect(inputData.checkItemContents).toEqual(['可読性チェック', 'テストカバレッジ']);
    expect(inputData.concurrentReviewCount).toBeNull();
    expect(inputData.ratings).toEqual([
      { label: 'A', definition: '完全に満たしている' },
      { label: 'B', definition: '概ね満たしている' },
    ]);
    expect(inputData.commentFormat).toBe('{comment}');
    expect(inputData.additionalInstructions).toBe('Be thorough');
    expect(inputData.mrTitle).toBe('Test MR');
    expect(inputData.mrDescription).toBe('Test description');
    expect(inputData.mrSourceBranch).toBe('feature/test');
    expect(inputData.mrTargetBranch).toBe('main');
    expect(inputData.mrDiff).toBe('+ added line');
    expect(inputData.mrCommitHash).toBe('abc123');
    expect(inputData.priorReviewResults).toBeNull();
    expect(inputData.priorCommitMessages).toBeNull();
    expect(inputData.priorDiffSincePrior).toBeNull();
    expect(inputData.skillsPaths).toEqual(['/path/to/skills']);
    expect(inputData.resultFilePath).toBe('/tmp/result.json');
    expect(inputData.folderTree).toBe('src/\n  index.ts');
    expect(inputData.commentLanguage).toBe('Japanese');
    expect(inputData.omittedFileDiffs).toBeNull();
    expect(inputData.allDiffFilePaths).toBeNull();
    expect(inputData.diffCompressed).toBe(false);
    expect(inputData.folderTreeRemovedByCompression).toBe(false);

    // RequestContextフィールドがInputDataに含まれないこと
    expect(inputData).not.toHaveProperty('userId');
    expect(inputData).not.toHaveProperty('projectId');
    expect(inputData).not.toHaveProperty('aiApiKey');
    expect(inputData).not.toHaveProperty('aiApiEndpointUrl');
    expect(inputData).not.toHaveProperty('aiModelName');
    expect(inputData).not.toHaveProperty('projectDir');
    expect(inputData).not.toHaveProperty('openaiReasoningEffort');

    // suggest関連フィールドがInputDataに含まれること
    expect(inputData.suggestEnabledRatingLabels).toEqual(['C']);
    expect(inputData.suggestResultFilePath).toBe('/tmp/suggest-result.json');
    expect(inputData.fullMrDiff).toBe('+ added line');
  });

  it('openaiReasoningEffort指定時にRequestContextに含まれること', async () => {
    const params = createParams({ openaiReasoningEffort: 'high' });

    await runner.run(params);

    const startCall = vi.mocked(mockStart).mock.calls[0][0] as {
      inputData: Record<string, unknown>;
      requestContext: { get(key: string): unknown };
    };

    expect(startCall.requestContext.get('openaiReasoningEffort')).toBe('high');
  });

  it('ワークフロー失敗時にエラーがスローされること', async () => {
    vi.mocked(mockStart).mockResolvedValueOnce({
      status: 'failed',
      error: new Error('Workflow execution error'),
    });

    const params = createParams();
    await expect(runner.run(params)).rejects.toThrow('Workflow failed: Workflow execution error');
  });
});
