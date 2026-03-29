import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRequestContext } from '../../requestContext.js';
import { initializeLogger, resetLogger } from '../../../lib/logger.js';

// Mastraインスタンスをimport（実Agent、実Workflowが登録された状態）
// ベストプラクティスに従い mastra.getWorkflow() / mastra.getAgent() 経由でアクセスする
import { mastra } from '../../index.js';

// Agentの参照を取得（vi.spyOnでメソッドをモック化する）
const reviewAgentInstance = mastra.getAgent('reviewAgent');
const checklistSplitAgentInstance = mastra.getAgent('checklistSplitAgent');

/**
 * テスト用のRequestContextを作成するヘルパー
 */
function createWorkflowRequestContext(): RequestContext<WorkflowRequestContext> {
  return new RequestContext<WorkflowRequestContext>([
    ['userId', 'test-user'],
    ['aiApiKey', 'test-key'],
    ['aiApiEndpointUrl', 'http://localhost:8080'],
    ['aiModelName', 'test-model'],
    ['projectDir', '/test/project'],
  ]);
}

/**
 * テスト用のワークフロー入力データを作成するヘルパー
 */
function createWorkflowInput(overrides: Record<string, unknown> = {}) {
  return {
    checkItemContents: ['security check', 'performance check'],
    concurrentReviewCount: 1,
    ratings: [
      { label: 'A', definition: 'Fully satisfies requirements' },
      { label: 'B', definition: 'Partially satisfies requirements' },
    ],
    commentFormat: '## Review\n{comment}',
    additionalInstructions: '',
    mrTitle: 'Test MR',
    mrDescription: 'Test description',
    mrSourceBranch: 'feature/test',
    mrTargetBranch: 'main',
    mrDiff: '+ added line',
    mrCommitHash: 'abc123',
    priorReviewResults: null,
    priorCommitMessages: null,
    priorDiffSincePrior: null,
    skillsPaths: [],
    resultFilePath: '',
    folderTree: 'src/\n  index.ts',
    commentLanguage: 'Japanese',
    ...overrides,
  };
}

/**
 * 結果ファイルにレビュー結果を書き込むヘルパー（ID方式）
 */
function writeResultsToFile(
  filePath: string,
  results: Array<{
    checkItemId: number;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError: boolean;
    errorMessage?: string;
  }>,
): void {
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');
}

/**
 * ワークフロー結果からoutputを安全に取得するヘルパー
 */
function getSuccessResult(result: { status: string; [key: string]: unknown }): {
  results: Array<{ checkItemContent: string; isError: boolean; errorMessage?: string }>;
} {
  if (result.status !== 'success') {
    throw new Error(`Expected success but got ${result.status}`);
  }
  return (
    result as unknown as {
      result: {
        results: Array<{ checkItemContent: string; isError: boolean; errorMessage?: string }>;
      };
    }
  ).result;
}

describe('reviewWorkflow 結合テスト', () => {
  let tmpDir: string;
  let resultFilePath: string;

  /**
   * RequestContextからcheckItemsを取り出し、結果ファイルに未登録の項目を追記するモック実装
   */
  const mockGenerateWithFileWrite = async (_prompt: unknown, options: unknown) => {
    const opts = options as { requestContext: RequestContext };
    const checkItems = opts.requestContext.get('checkItems') as Array<{
      id: number;
      content: string;
    }>;

    const existing = fs.existsSync(resultFilePath)
      ? JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'))
      : [];

    for (const item of checkItems) {
      if (!existing.some((r: { checkItemId: number }) => r.checkItemId === item.id)) {
        existing.push({
          checkItemId: item.id,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: `Review for ${item.content}`,
          isError: false,
        });
      }
    }

    writeResultsToFile(resultFilePath, existing);
    return {};
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-'));
    resultFilePath = path.join(tmpDir, 'results.json');
    // 実Agentのメソッドをspyでモック化
    vi.spyOn(reviewAgentInstance, 'generate');
    vi.spyOn(checklistSplitAgentInstance, 'generate');
    // Memory操作を無効化（ストレージアクセスを回避）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(reviewAgentInstance, 'getMemory').mockResolvedValue(undefined as any);
    initializeLogger({ userId: 'test-user', level: 'silent' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    resetLogger();
  });

  it('concurrentReviewCount=nullでend-to-end実行できる（分割なし）', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['security check', 'performance check'],
      concurrentReviewCount: null,
      resultFilePath,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(reviewAgentInstance.generate).mockImplementation(mockGenerateWithFileWrite as any);

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    expect(result.status).toBe('success');
    const output = getSuccessResult(result);
    expect(output.results).toHaveLength(2);
    expect(output.results.every((r) => !r.isError)).toBe(true);

    // 全項目がレビューされていること
    const reviewedContents = output.results.map((r) => r.checkItemContent).sort();
    expect(reviewedContents).toEqual(['performance check', 'security check']);

    // ChecklistSplitAgentが呼ばれないこと（分割なし）
    expect(checklistSplitAgentInstance.generate).not.toHaveBeenCalled();
  });

  it('concurrentReviewCount=1でend-to-end実行できる', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['security check', 'performance check'],
      concurrentReviewCount: 1,
      resultFilePath,
    });

    // ReviewAgentのgenerate()を設定: 各呼び出しで結果を結果ファイルに書き込む
    vi.mocked(reviewAgentInstance.generate).mockImplementation(async () => {
      const existing = fs.existsSync(resultFilePath)
        ? JSON.parse(fs.readFileSync(resultFilePath, 'utf-8'))
        : [];

      // foreachで1グループ1項目ずつ処理されるため、呼び出しごとにIDでマッチ
      const nextId = existing.length === 0 ? 1 : 2;
      const nextItem = nextId === 1 ? 'security check' : 'performance check';

      if (!existing.some((r: { checkItemId: number }) => r.checkItemId === nextId)) {
        existing.push({
          checkItemId: nextId,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: `Review for ${nextItem}`,
          isError: false,
        });
        writeResultsToFile(resultFilePath, existing);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    });

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    expect(result.status).toBe('success');
    const output = getSuccessResult(result);
    expect(output.results).toHaveLength(2);
    expect(output.results.every((r) => !r.isError)).toBe(true);

    // 両方の項目がレビューされていること
    const reviewedContents = output.results.map((r) => r.checkItemContent).sort();
    expect(reviewedContents).toEqual(['performance check', 'security check']);
  });

  it('concurrentReviewCount=2でforeachが正しく並列実行される', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['item1', 'item2', 'item3', 'item4'],
      concurrentReviewCount: 2,
      resultFilePath,
    });

    // ChecklistSplitAgentはID番号でグループを返す
    vi.mocked(checklistSplitAgentInstance.generate).mockResolvedValue({
      object: {
        groups: [
          [1, 2],
          [3, 4],
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(reviewAgentInstance.generate).mockImplementation(mockGenerateWithFileWrite as any);

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    expect(result.status).toBe('success');
    const output = getSuccessResult(result);
    expect(output.results).toHaveLength(4);

    // 全項目がレビューされていること
    const reviewedContents = output.results.map((r) => r.checkItemContent).sort();
    expect(reviewedContents).toEqual(['item1', 'item2', 'item3', 'item4']);
  });

  it('Agent失敗時にエラー結果が返される', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['check1'],
      concurrentReviewCount: 1,
      resultFilePath,
    });

    // ReviewAgentがエラーをスロー
    vi.mocked(reviewAgentInstance.generate).mockRejectedValue(new Error('AI API failed'));

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    expect(result.status).toBe('success');
    const output = getSuccessResult(result);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].isError).toBe(true);
    // 通常ErrorはAPICallErrorではないためunknownに分類され、定型メッセージが返される
    expect(output.results[0].errorMessage).toBe('予期せぬエラー（実行ログを確認してください）');
  });

  it('RequestContextの値がAgent呼び出しに渡される', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['check1'],
      concurrentReviewCount: 1,
      resultFilePath,
    });

    vi.mocked(reviewAgentInstance.generate).mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Good',
          isError: false,
        },
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    });

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    await run.start({ inputData, requestContext });

    expect(reviewAgentInstance.generate).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = vi.mocked(reviewAgentInstance.generate).mock.calls[0] as any[];
    const options = callArgs[1] as { requestContext: RequestContext };
    expect(options.requestContext).toBeDefined();

    expect(options.requestContext.get('userId')).toBe('test-user');
    expect(options.requestContext.get('aiApiKey')).toBe('test-key');
    // チェック項目はIndexedCheckItem[]形式で渡される
    const checkItems = options.requestContext.get('checkItems') as Array<{
      id: number;
      content: string;
    }>;
    expect(checkItems).toEqual([{ id: 1, content: 'check1' }]);
  });

  it('priorReviewResultsがある場合にpriorReviewContextが正しく組み立てられる', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['check1'],
      concurrentReviewCount: 1,
      resultFilePath,
      priorReviewResults: [
        {
          checkItemContent: 'check1',
          ratingLabel: 'B',
          ratingDefinition: 'Partially satisfies requirements',
          comment: 'Previous review comment',
        },
      ],
      priorCommitMessages: ['fix: update implementation'],
      priorDiffSincePrior: '+ new change',
    });

    vi.mocked(reviewAgentInstance.generate).mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Improved',
          isError: false,
        },
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    });

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    expect(result.status).toBe('success');
    const output = getSuccessResult(result);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].isError).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = vi.mocked(reviewAgentInstance.generate).mock.calls[0] as any[];
    const options = callArgs[1] as { requestContext: RequestContext };
    const priorCtx = options.requestContext.get('priorReviewContext') as {
      results: Array<{ checkItemContent: string }>;
      commitMessages: string[];
      diffSincePrior: string;
    };
    expect(priorCtx).not.toBeNull();
    expect(priorCtx.results[0].checkItemContent).toBe('check1');
    expect(priorCtx.commitMessages).toEqual(['fix: update implementation']);
    expect(priorCtx.diffSincePrior).toBe('+ new change');
  });

  it('複数グループに分割される場合、各Agentは自グループのチェック項目に対応する過去結果のみ受け取る', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['item1', 'item2', 'item3', 'item4'],
      concurrentReviewCount: 2,
      resultFilePath,
      priorReviewResults: [
        {
          checkItemContent: 'item1',
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Prior comment for item1',
        },
        {
          checkItemContent: 'item2',
          ratingLabel: 'B',
          ratingDefinition: 'Partially satisfies requirements',
          comment: 'Prior comment for item2',
        },
        {
          checkItemContent: 'item3',
          ratingLabel: 'A',
          ratingDefinition: 'Fully satisfies requirements',
          comment: 'Prior comment for item3',
        },
        {
          checkItemContent: 'item4',
          ratingLabel: 'B',
          ratingDefinition: 'Partially satisfies requirements',
          comment: 'Prior comment for item4',
        },
      ],
      priorCommitMessages: ['fix: update'],
      priorDiffSincePrior: '+ change',
    });

    // ChecklistSplitAgentはID番号でグループを返す
    vi.mocked(checklistSplitAgentInstance.generate).mockResolvedValue({
      object: {
        groups: [
          [1, 2],
          [3, 4],
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(reviewAgentInstance.generate).mockImplementation(mockGenerateWithFileWrite as any);

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    expect(result.status).toBe('success');
    const output = getSuccessResult(result);
    expect(output.results).toHaveLength(4);

    // 各Agent呼び出しのpriorReviewContextを検証
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = vi.mocked(reviewAgentInstance.generate).mock.calls as any[][];
    // foreachで2グループ分の呼び出しがあるはず
    expect(calls.length).toBeGreaterThanOrEqual(2);

    for (const call of calls) {
      const opts = call[1] as { requestContext: RequestContext };
      const checkItems = opts.requestContext.get('checkItems') as Array<{
        id: number;
        content: string;
      }>;
      const priorCtx = opts.requestContext.get('priorReviewContext') as {
        results: Array<{ checkItemContent: string }>;
      } | null;

      if (priorCtx) {
        const groupContents = checkItems.map((i) => i.content);
        // 過去結果は自グループのチェック項目のみであること
        for (const r of priorCtx.results) {
          expect(groupContents).toContain(r.checkItemContent);
        }
        // 自グループに対応する過去結果が全て含まれていること
        for (const content of groupContents) {
          expect(priorCtx.results.some((r) => r.checkItemContent === content)).toBe(true);
        }
      }
    }
  });

  it('errorMessageフィールドがある場合に結果に含まれる', async () => {
    const inputData = createWorkflowInput({
      checkItemContents: ['check1'],
      concurrentReviewCount: 1,
      resultFilePath,
    });

    vi.mocked(reviewAgentInstance.generate).mockImplementation(async () => {
      writeResultsToFile(resultFilePath, [
        {
          checkItemId: 1,
          ratingLabel: 'エラー',
          ratingDefinition: 'エラー',
          comment: 'Error occurred',
          isError: true,
          errorMessage: 'Tool execution failed',
        },
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    });

    const requestContext = createWorkflowRequestContext();
    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

    expect(result.status).toBe('success');
    const output = getSuccessResult(result);
    expect(output.results).toHaveLength(1);
    expect(output.results[0].isError).toBe(true);
    expect(output.results[0].errorMessage).toBe('Tool execution failed');
  });
});
