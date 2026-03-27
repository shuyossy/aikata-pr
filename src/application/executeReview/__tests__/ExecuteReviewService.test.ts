import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecuteReviewService } from '../ExecuteReviewService.js';
import type { ReviewWorkflowRunner, ReviewWorkflowResult } from '../ExecuteReviewService.js';
import type { ExecuteReviewCommand } from '../ExecuteReviewCommand.js';
import type { MrGateway } from '../../shared/port/gateway/index.js';
import type { MrCommentGateway, MrComment } from '../../shared/port/gateway/index.js';
import { MrContext } from '../../../domain/mrContext/index.js';
import { CheckItem } from '../../../domain/checkItem/index.js';
import { Checklist } from '../../../domain/checklist/index.js';
import { Rating } from '../../../domain/rating/index.js';
import { ReviewSettings } from '../../../domain/reviewSettings/index.js';
import { ReviewResult } from '../../../domain/reviewResult/index.js';
import { CommentFormatter } from '../../shared/comment/index.js';

// ヘルパー: テスト用のMrContextを生成
function createMrContext(
  overrides?: Partial<ConstructorParameters<typeof MrContext>[0]>,
): MrContext {
  return new MrContext({
    title: 'Test MR',
    description: 'Test description',
    sourceBranch: 'feature/test',
    targetBranch: 'main',
    diff: 'diff content',
    commitHash: 'current-commit-hash',
    ...overrides,
  });
}

// ヘルパー: テスト用のExecuteReviewCommandを生成
function createCommand(overrides?: Partial<ExecuteReviewCommand>): ExecuteReviewCommand {
  return {
    userId: 'test-user',
    projectId: 'project-1',
    mrIid: '42',
    checklist: new Checklist([new CheckItem('コードの可読性'), new CheckItem('テストカバレッジ')]),
    reviewSettings: new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: 1,
      commentFormat: '{comment}',
      ratings: [
        new Rating('A', '完全に満たしている'),
        new Rating('B', '概ね満たしている'),
        new Rating('C', '満たしていない'),
      ],
    }),
    skillsPaths: [],
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://api.example.com',
    aiModelName: 'openai/o4-mini',
    gitlabToken: 'test-gitlab-token',
    ...overrides,
  };
}

// ヘルパー: テスト用のワークフロー結果を生成
function createWorkflowResult(overrides?: Partial<ReviewWorkflowResult>): ReviewWorkflowResult {
  return {
    results: [
      {
        checkItemContent: 'コードの可読性',
        ratingLabel: 'A',
        ratingDefinition: '完全に満たしている',
        comment: '良いコードです',
        isError: false,
      },
      {
        checkItemContent: 'テストカバレッジ',
        ratingLabel: 'B',
        ratingDefinition: '概ね満たしている',
        comment: 'テストを追加してください',
        isError: false,
      },
    ],
    ...overrides,
  };
}

// ヘルパー: aikataレビューコメントを生成
function createAikataComment(
  items: { content: string; ratingLabel: string; ratingDefinition: string; comment: string }[],
  commitHash: string,
  ratings: Rating[],
  createdAt: string,
): MrComment {
  const results = items.map((item) => {
    const rating = ratings.find((r) => r.label === item.ratingLabel);
    if (!rating) throw new Error(`Rating not found: ${item.ratingLabel}`);
    return ReviewResult.success(new CheckItem(item.content), rating, item.comment);
  });
  const body = CommentFormatter.formatComment(results, ratings, commitHash);
  return { id: 1, body, createdAt };
}

describe('ExecuteReviewService', () => {
  let mrGateway: MrGateway;
  let mrCommentGateway: MrCommentGateway;
  let workflowRunner: ReviewWorkflowRunner;
  let service: ExecuteReviewService;

  beforeEach(() => {
    mrGateway = {
      getMrContext: vi.fn(),
      getCommitsSince: vi.fn(),
      getDiffSince: vi.fn(),
    };
    mrCommentGateway = {
      getComments: vi.fn(),
      postComment: vi.fn(),
    };
    workflowRunner = {
      run: vi.fn(),
    };
    service = new ExecuteReviewService(mrGateway, mrCommentGateway, workflowRunner);
  });

  it('正常系: 事前処理→Workflow実行→コメント投稿の全フローが実行される', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([]); // 過去コメントなし
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    const result = await service.execute(command);

    // Step 0: MRコンテキスト取得
    expect(mrGateway.getMrContext).toHaveBeenCalledWith('project-1', '42');
    // Step 0: 過去コメント取得
    expect(mrCommentGateway.getComments).toHaveBeenCalledWith('project-1', '42');
    // Steps 1-2: Workflow実行
    expect(workflowRunner.run).toHaveBeenCalledOnce();
    // Step 3: コメント投稿
    expect(mrCommentGateway.postComment).toHaveBeenCalledOnce();
    expect(mrCommentGateway.postComment).toHaveBeenCalledWith(
      'project-1',
      '42',
      expect.stringContaining('コードの可読性'),
    );

    // 結果の検証
    expect(result.results).toHaveLength(2);
    expect(result.commitHash).toBe('current-commit-hash');
    expect(result.commentPosted).toBe(true);
    expect(result.results[0].checkItem.content).toBe('コードの可読性');
    expect(result.results[0].rating.label).toBe('A');
    expect(result.results[1].checkItem.content).toBe('テストカバレッジ');
    expect(result.results[1].rating.label).toBe('B');
  });

  it('過去のチェック結果が存在する場合、PriorReviewContextが生成される', async () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    // 過去のaikataレビューコメントを用意
    const priorComment = createAikataComment(
      [
        {
          content: 'コードの可読性',
          ratingLabel: 'B',
          ratingDefinition: '概ね満たしている',
          comment: '改善してください',
        },
        {
          content: 'テストカバレッジ',
          ratingLabel: 'C',
          ratingDefinition: '満たしていない',
          comment: 'テスト不足',
        },
      ],
      'prior-commit-hash',
      ratings,
      '2026-01-01T00:00:00Z',
    );

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue([
      'fix: improve code',
      'test: add tests',
    ]);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('diff since prior');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    await service.execute(command);

    // Workflow実行時にprior情報が渡されていることを確認
    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).toEqual([
      {
        checkItemContent: 'コードの可読性',
        ratingLabel: 'B',
        ratingDefinition: '概ね満たしている',
        comment: '改善してください',
      },
      {
        checkItemContent: 'テストカバレッジ',
        ratingLabel: 'C',
        ratingDefinition: '満たしていない',
        comment: 'テスト不足',
      },
    ]);
    expect(runCall.priorCommitMessages).toEqual(['fix: improve code', 'test: add tests']);
    expect(runCall.priorDiffSincePrior).toBe('diff since prior');

    // コミット情報取得が正しいハッシュで呼ばれたことを確認
    expect(mrGateway.getCommitsSince).toHaveBeenCalledWith('project-1', '42', 'prior-commit-hash');
    expect(mrGateway.getDiffSince).toHaveBeenCalledWith(
      'project-1',
      '42',
      'prior-commit-hash',
      'current-commit-hash',
    );
  });

  it('過去のチェック結果が存在しない場合、PriorReviewContextはnull', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([]); // 過去コメントなし
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    await service.execute(command);

    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).toBeNull();
    expect(runCall.priorCommitMessages).toBeNull();
    expect(runCall.priorDiffSincePrior).toBeNull();

    // getCommitsSince/getDiffSinceは呼ばれない
    expect(mrGateway.getCommitsSince).not.toHaveBeenCalled();
    expect(mrGateway.getDiffSince).not.toHaveBeenCalled();
  });

  it('過去のチェック結果のうち、今回のチェックリストに含まれない項目は除外される', async () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];
    // 今回のチェックリストには「コードの可読性」と「テストカバレッジ」のみ
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    // 過去のレビューには今回含まれない「セキュリティ」項目もある
    const priorComment = createAikataComment(
      [
        {
          content: 'コードの可読性',
          ratingLabel: 'A',
          ratingDefinition: '完全に満たしている',
          comment: '良いです',
        },
        {
          content: 'セキュリティ',
          ratingLabel: 'C',
          ratingDefinition: '満たしていない',
          comment: '脆弱性あり',
        },
        {
          content: 'テストカバレッジ',
          ratingLabel: 'B',
          ratingDefinition: '概ね満たしている',
          comment: 'もう少し',
        },
      ],
      'prior-commit-hash',
      ratings,
      '2026-01-01T00:00:00Z',
    );

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    await service.execute(command);

    // 「セキュリティ」は除外され、「コードの可読性」と「テストカバレッジ」のみ
    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).toHaveLength(2);
    expect(runCall.priorReviewResults!.map((r) => r.checkItemContent)).toEqual([
      'コードの可読性',
      'テストカバレッジ',
    ]);
  });

  it('コメント投稿が成功する', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    const result = await service.execute(command);

    // コメントが正しいフォーマットで投稿される
    expect(mrCommentGateway.postComment).toHaveBeenCalledOnce();
    const postedBody = vi.mocked(mrCommentGateway.postComment).mock.calls[0][2];
    expect(postedBody).toContain('<!-- aikata-review -->');
    expect(postedBody).toContain('コードの可読性');
    expect(postedBody).toContain('テストカバレッジ');
    expect(postedBody).toContain('current-commit-hash');
    expect(result.commentPosted).toBe(true);
  });

  it('エラー時に適切なエラーがスローされる', async () => {
    const command = createCommand();

    // MRコンテキスト取得でエラー
    vi.mocked(mrGateway.getMrContext).mockRejectedValue(new Error('GitLab API error'));

    await expect(service.execute(command)).rejects.toThrow('GitLab API error');
  });

  it('ワークフロー結果にエラー項目がある場合、ReviewResult.errorが生成される', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult: ReviewWorkflowResult = {
      results: [
        {
          checkItemContent: 'コードの可読性',
          ratingLabel: 'A',
          ratingDefinition: '完全に満たしている',
          comment: '良いコードです',
          isError: false,
        },
        {
          checkItemContent: 'テストカバレッジ',
          ratingLabel: '',
          ratingDefinition: '',
          comment: '',
          isError: true,
          errorMessage: 'AI processing timeout',
        },
      ],
    };

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    const result = await service.execute(command);

    expect(result.results).toHaveLength(2);
    expect(result.results[0].isError).toBe(false);
    expect(result.results[1].isError).toBe(true);
    expect(result.results[1].errorMessage).toBe('AI processing timeout');
  });

  it('複数のaikataコメントがある場合、最新のコメントのみ使用される', async () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    // 古い方のコメント
    const olderComment = createAikataComment(
      [
        {
          content: 'コードの可読性',
          ratingLabel: 'C',
          ratingDefinition: '満たしていない',
          comment: '古い結果',
        },
      ],
      'older-commit-hash',
      ratings,
      '2025-12-01T00:00:00Z',
    );

    // 新しい方のコメント
    const newerComment = createAikataComment(
      [
        {
          content: 'コードの可読性',
          ratingLabel: 'B',
          ratingDefinition: '概ね満たしている',
          comment: '新しい結果',
        },
      ],
      'newer-commit-hash',
      ratings,
      '2026-01-01T00:00:00Z',
    );

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    // 古い順で返されても、新しい方が使われる
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([olderComment, newerComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['new commit']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('new diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    await service.execute(command);

    // 新しいコメントのcommitHashでgetCommitsSinceが呼ばれる
    expect(mrGateway.getCommitsSince).toHaveBeenCalledWith('project-1', '42', 'newer-commit-hash');
  });

  it('非aikataコメントはスキップされて次のコメントが評価される', async () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    // 非aikataコメント（parseCommentがnullを返す）
    const normalComment: { id: number; body: string; createdAt: string } = {
      id: 100,
      body: 'This is a normal comment, not an aikata review',
      createdAt: '2026-01-02T00:00:00Z',
    };

    // aikataコメント（古い方）
    const aikataComment = createAikataComment(
      [
        {
          content: 'コードの可読性',
          ratingLabel: 'B',
          ratingDefinition: '概ね満たしている',
          comment: '改善してください',
        },
      ],
      'prior-commit-hash',
      ratings,
      '2026-01-01T00:00:00Z',
    );

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    // 非aikataコメントが新しい＝最初に評価されるがスキップされる
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([aikataComment, normalComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    await service.execute(command);

    // 非aikataコメントはスキップされ、aikataコメントが使われる
    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).not.toBeNull();
    expect(runCall.priorReviewResults).toHaveLength(1);
    expect(runCall.priorReviewResults![0].checkItemContent).toBe('コードの可読性');
  });

  it('aikataコメントのフィルタ後に該当項目が0件の場合、nullが返される', async () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    // 今回のチェックリストには「コードの可読性」「テストカバレッジ」があるが、
    // 過去のレビューにはどちらも含まれていない（別の項目のみ）
    const aikataComment = createAikataComment(
      [
        {
          content: 'セキュリティ',
          ratingLabel: 'A',
          ratingDefinition: '完全に満たしている',
          comment: '問題なし',
        },
      ],
      'prior-commit-hash',
      ratings,
      '2026-01-01T00:00:00Z',
    );

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([aikataComment]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    await service.execute(command);

    // フィルタ後に0件なのでnull
    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).toBeNull();
    expect(runCall.priorCommitMessages).toBeNull();
    expect(runCall.priorDiffSincePrior).toBeNull();

    // getCommitsSince/getDiffSinceは呼ばれない
    expect(mrGateway.getCommitsSince).not.toHaveBeenCalled();
    expect(mrGateway.getDiffSince).not.toHaveBeenCalled();
  });

  it('ワークフロー結果にチェックリストに存在しない項目がある場合、エラーがスローされる', async () => {
    const command = createCommand();
    const mrContext = createMrContext();

    // 存在しないチェック項目を含むワークフロー結果
    const workflowResult: ReviewWorkflowResult = {
      results: [
        {
          checkItemContent: '存在しない項目',
          ratingLabel: 'A',
          ratingDefinition: '完全に満たしている',
          comment: '良い',
          isError: false,
        },
      ],
    };

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    await expect(service.execute(command)).rejects.toThrow('Check item not found: 存在しない項目');
  });

  it('Workflow実行時に正しいパラメータが渡される', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrCommentGateway.getComments).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrCommentGateway.postComment).mockResolvedValue(undefined);

    await service.execute(command);

    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.checkItemContents).toEqual(['コードの可読性', 'テストカバレッジ']);
    expect(runCall.concurrentReviewCount).toBe(1);
    expect(runCall.ratings).toEqual([
      { label: 'A', definition: '完全に満たしている' },
      { label: 'B', definition: '概ね満たしている' },
      { label: 'C', definition: '満たしていない' },
    ]);
    expect(runCall.commentFormat).toBe('{comment}');
    expect(runCall.additionalInstructions).toBe('');
    expect(runCall.mrTitle).toBe('Test MR');
    expect(runCall.mrDescription).toBe('Test description');
    expect(runCall.mrSourceBranch).toBe('feature/test');
    expect(runCall.mrTargetBranch).toBe('main');
    expect(runCall.mrDiff).toBe('diff content');
    expect(runCall.mrCommitHash).toBe('current-commit-hash');
    expect(runCall.userId).toBe('test-user');
    expect(runCall.aiApiKey).toBe('test-api-key');
    expect(runCall.aiApiEndpointUrl).toBe('https://api.example.com');
    expect(runCall.aiModelName).toBe('openai/o4-mini');
    expect(runCall.skillsPaths).toEqual([]);
  });
});
