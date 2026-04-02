import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecuteReviewService } from '../ExecuteReviewService.js';
import type { ReviewWorkflowRunner, ReviewWorkflowResult } from '../ExecuteReviewService.js';
import type { ExecuteReviewCommand } from '../ExecuteReviewCommand.js';
import type { MrGateway } from '../../shared/port/gateway/index.js';
import type { MrDiscussionGateway, MrComment } from '../../shared/port/gateway/index.js';
import type { ProjectTreeGateway } from '../../shared/port/gateway/index.js';
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
    commitMessage: 'feat: test commit message',
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
      concurrentReviewCount: null,
      commentFormat: '{comment}',
      ratings: [
        new Rating('A', '完全に満たしている'),
        new Rating('B', '概ね満たしている'),
        new Rating('C', '満たしていない'),
      ],
      hiddenRatingLabels: [],
    }),
    skillsPaths: [],
    projectDir: '/test/project',
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://api.example.com',
    aiModelName: 'openai/o4-mini',
    gitlabToken: 'test-gitlab-token',
    treeMaxDepth: undefined,
    commentLanguage: 'Japanese',
    openaiReasoningEffort: undefined,
    maxContextLength: undefined,
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

// ヘルパー: aikataレビューコメントを生成（エラー項目対応）
function createAikataComment(
  items: {
    content: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError?: boolean;
  }[],
  commitHash: string,
  ratings: Rating[],
  createdAt: string,
  hiddenRatingLabels: string[] = [],
): MrComment {
  const results = items.map((item) => {
    if (item.isError) {
      return ReviewResult.error(new CheckItem(item.content), item.comment);
    }
    const rating = ratings.find((r) => r.label === item.ratingLabel);
    if (!rating) throw new Error(`Rating not found: ${item.ratingLabel}`);
    return ReviewResult.success(new CheckItem(item.content), rating, item.comment);
  });
  const body = CommentFormatter.formatComment(
    results,
    ratings,
    commitHash,
    'test commit',
    hiddenRatingLabels,
  );
  return { id: 1, body, createdAt };
}

describe('ExecuteReviewService', () => {
  let mrGateway: MrGateway;
  let mrDiscussionGateway: MrDiscussionGateway;
  let workflowRunner: ReviewWorkflowRunner;
  let projectTreeGateway: ProjectTreeGateway;
  let service: ExecuteReviewService;

  beforeEach(() => {
    mrGateway = {
      getMrContext: vi.fn(),
      getCommitsSince: vi.fn(),
      getDiffSince: vi.fn(),
    };
    mrDiscussionGateway = {
      getDiscussions: vi.fn(),
      postDiscussion: vi.fn(),
    };
    workflowRunner = {
      run: vi.fn(),
    };
    projectTreeGateway = {
      getTree: vi.fn().mockResolvedValue('src/\n  index.ts'),
    };
    service = new ExecuteReviewService(
      mrGateway,
      mrDiscussionGateway,
      workflowRunner,
      projectTreeGateway,
    );
  });

  it('正常系: 事前処理→Workflow実行→コメント投稿の全フローが実行される', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]); // 過去コメントなし
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    const result = await service.execute(command);

    // Step 0: MRコンテキスト取得
    expect(mrGateway.getMrContext).toHaveBeenCalledWith('project-1', '42');
    // Step 0: 過去コメント取得
    expect(mrDiscussionGateway.getDiscussions).toHaveBeenCalledWith('project-1', '42');
    // Steps 1-2: Workflow実行
    expect(workflowRunner.run).toHaveBeenCalledOnce();
    // Step 3: コメント投稿
    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();
    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledWith(
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
    expect(result.allResultsAreErrors).toBe(false);
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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue([
      'fix: improve code',
      'test: add tests',
    ]);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('diff since prior');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]); // 過去コメントなし
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    const result = await service.execute(command);

    // コメントが正しいフォーマットで投稿される
    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();
    const postedBody = vi.mocked(mrDiscussionGateway.postDiscussion).mock.calls[0][2];
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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    const result = await service.execute(command);

    expect(result.results).toHaveLength(2);
    expect(result.results[0].isError).toBe(false);
    expect(result.results[1].isError).toBe(true);
    expect(result.results[1].errorMessage).toBe('AI processing timeout');
    expect(result.allResultsAreErrors).toBe(false);
  });

  it('フルレビューで全てのレビュー結果がエラーの場合、allResultsAreErrorsがtrueになる', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult: ReviewWorkflowResult = {
      results: [
        {
          checkItemContent: 'コードの可読性',
          ratingLabel: '',
          ratingDefinition: '',
          comment: '',
          isError: true,
          errorMessage: 'API error',
        },
        {
          checkItemContent: 'テストカバレッジ',
          ratingLabel: '',
          ratingDefinition: '',
          comment: '',
          isError: true,
          errorMessage: 'Timeout',
        },
      ],
    };

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    const result = await service.execute(command);

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.isError)).toBe(true);
    expect(result.allResultsAreErrors).toBe(true);
    // コメントは投稿されている
    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();
    expect(result.commentPosted).toBe(true);
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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([olderComment, newerComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['new commit']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('new diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([aikataComment, normalComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([aikataComment]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

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
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    await expect(service.execute(command)).rejects.toThrow('Check item not found: 存在しない項目');
  });

  it('Workflow実行時に正しいパラメータが渡される', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    await service.execute(command);

    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.checkItemContents).toEqual(['コードの可読性', 'テストカバレッジ']);
    expect(runCall.concurrentReviewCount).toBeNull();
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
    expect(runCall.folderTree).toBe('src/\n  index.ts');
    expect(runCall.commentLanguage).toBe('Japanese');
  });

  it('ProjectTreeGateway.getTreeが正しい引数で呼ばれる', async () => {
    const command = createCommand({ treeMaxDepth: 3 });
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    await service.execute(command);

    expect(projectTreeGateway.getTree).toHaveBeenCalledWith('/test/project', { maxDepth: 3 });
  });

  it('ProjectTreeGateway.getTreeのエラーが伝播される', async () => {
    const command = createCommand();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(createMrContext());
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
    vi.mocked(projectTreeGateway.getTree).mockRejectedValue(new Error('Tree retrieval failed'));

    await expect(service.execute(command)).rejects.toThrow('Tree retrieval failed');
  });

  it('過去のチェック結果にエラー項目がある場合、エラー項目が除外されて正常項目のみpriorReviewResultsに含まれる', async () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    // 前回のレビューには正常項目とエラー項目が混在
    const priorComment = createAikataComment(
      [
        {
          content: 'コードの可読性',
          ratingLabel: 'A',
          ratingDefinition: '完全に満たしている',
          comment: '良いです',
        },
        {
          content: 'テストカバレッジ',
          ratingLabel: '',
          ratingDefinition: '',
          comment: 'AI processing timeout',
          isError: true,
        },
      ],
      'prior-commit-hash',
      ratings,
      '2026-01-01T00:00:00Z',
    );

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    await service.execute(command);

    // エラー項目「テストカバレッジ」は除外され、正常項目「コードの可読性」のみ
    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).toHaveLength(1);
    expect(runCall.priorReviewResults![0].checkItemContent).toBe('コードの可読性');
    expect(runCall.priorReviewResults![0].ratingLabel).toBe('A');
  });

  it('過去のチェック結果が全てエラーの場合、priorReviewContextがnullになる', async () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    // 前回のレビューは全てエラー
    const priorComment = createAikataComment(
      [
        {
          content: 'コードの可読性',
          ratingLabel: '',
          ratingDefinition: '',
          comment: 'API error occurred',
          isError: true,
        },
        {
          content: 'テストカバレッジ',
          ratingLabel: '',
          ratingDefinition: '',
          comment: 'AI processing timeout',
          isError: true,
        },
      ],
      'prior-commit-hash',
      ratings,
      '2026-01-01T00:00:00Z',
    );

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
    vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

    await service.execute(command);

    // 全てエラーなのでnull
    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).toBeNull();
    expect(runCall.priorCommitMessages).toBeNull();
    expect(runCall.priorDiffSincePrior).toBeNull();

    // getCommitsSince/getDiffSinceは呼ばれない
    expect(mrGateway.getCommitsSince).not.toHaveBeenCalled();
    expect(mrGateway.getDiffSince).not.toHaveBeenCalled();
  });

  describe('リトライ実行（同一コミットハッシュ）', () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
      new Rating('C', '満たしていない'),
    ];

    it('全項目が前回成功の場合、workflowは実行されず前回結果がそのまま投稿される', async () => {
      const command = createCommand();
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回のレビュー: 全項目成功、同じコミットハッシュ
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良いコードです',
          },
          {
            content: 'テストカバレッジ',
            ratingLabel: 'B',
            ratingDefinition: '概ね満たしている',
            comment: 'もう少し',
          },
        ],
        'same-hash', // 同じコミットハッシュ
        ratings,
        '2026-01-01T00:00:00Z',
      );

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      // workflowは実行されない
      expect(workflowRunner.run).not.toHaveBeenCalled();

      // コメントは投稿される
      expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();

      // 結果が前回と同じ
      expect(result.results).toHaveLength(2);
      expect(result.results[0].checkItem.content).toBe('コードの可読性');
      expect(result.results[0].rating.label).toBe('A');
      expect(result.results[0].comment).toBe('良いコードです');
      expect(result.results[1].checkItem.content).toBe('テストカバレッジ');
      expect(result.results[1].rating.label).toBe('B');
      expect(result.results[1].comment).toBe('もう少し');
      expect(result.commitHash).toBe('same-hash');
      expect(result.commentPosted).toBe(true);
    });

    it('一部エラー・一部成功の場合、エラー項目のみworkflowで再レビューされマージされる', async () => {
      const command = createCommand();
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回: コードの可読性=成功、テストカバレッジ=エラー
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良いです',
          },
          {
            content: 'テストカバレッジ',
            ratingLabel: '',
            ratingDefinition: '',
            comment: 'API error',
            isError: true,
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      // 再レビュー結果: テストカバレッジのみ
      const workflowResult: ReviewWorkflowResult = {
        results: [
          {
            checkItemContent: 'テストカバレッジ',
            ratingLabel: 'B',
            ratingDefinition: '概ね満たしている',
            comment: 'テスト追加済み',
            isError: false,
          },
        ],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      // workflowはエラー項目のみで実行
      expect(workflowRunner.run).toHaveBeenCalledOnce();
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.checkItemContents).toEqual(['テストカバレッジ']);
      // リトライ時はprior context不要
      expect(runCall.priorReviewResults).toBeNull();
      expect(runCall.priorCommitMessages).toBeNull();
      expect(runCall.priorDiffSincePrior).toBeNull();

      // マージ結果（チェックリスト順）
      expect(result.results).toHaveLength(2);
      expect(result.results[0].checkItem.content).toBe('コードの可読性');
      expect(result.results[0].rating.label).toBe('A');
      expect(result.results[0].comment).toBe('良いです');
      expect(result.results[1].checkItem.content).toBe('テストカバレッジ');
      expect(result.results[1].rating.label).toBe('B');
      expect(result.results[1].comment).toBe('テスト追加済み');
    });

    it('全項目エラーの場合、全項目がworkflowで再レビューされる', async () => {
      const command = createCommand();
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回: 全項目エラー
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: '',
            ratingDefinition: '',
            comment: 'API error',
            isError: true,
          },
          {
            content: 'テストカバレッジ',
            ratingLabel: '',
            ratingDefinition: '',
            comment: 'Timeout',
            isError: true,
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      // 全項目でworkflow実行
      expect(workflowRunner.run).toHaveBeenCalledOnce();
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.checkItemContents).toEqual(['コードの可読性', 'テストカバレッジ']);

      expect(result.results).toHaveLength(2);
    });

    it('リトライ時にワークフロー再実行後も全てエラーの場合、allResultsAreErrorsがtrueになる', async () => {
      const command = createCommand();
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回: 全項目エラー
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: '',
            ratingDefinition: '',
            comment: 'API error',
            isError: true,
          },
          {
            content: 'テストカバレッジ',
            ratingLabel: '',
            ratingDefinition: '',
            comment: 'Timeout',
            isError: true,
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      // 再レビューも全エラー
      const workflowResult: ReviewWorkflowResult = {
        results: [
          {
            checkItemContent: 'コードの可読性',
            ratingLabel: '',
            ratingDefinition: '',
            comment: '',
            isError: true,
            errorMessage: 'API error again',
          },
          {
            checkItemContent: 'テストカバレッジ',
            ratingLabel: '',
            ratingDefinition: '',
            comment: '',
            isError: true,
            errorMessage: 'Timeout again',
          },
        ],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.isError)).toBe(true);
      expect(result.allResultsAreErrors).toBe(true);
      expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();
    });

    it('チェックリストに新項目が追加された場合、新項目のみworkflowで再レビューされる', async () => {
      const command = createCommand({
        checklist: new Checklist([
          new CheckItem('コードの可読性'),
          new CheckItem('テストカバレッジ'),
          new CheckItem('セキュリティ'), // 新規追加
        ]),
      });
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回: 既存2項目は成功
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良い',
          },
          {
            content: 'テストカバレッジ',
            ratingLabel: 'B',
            ratingDefinition: '概ね満たしている',
            comment: 'OK',
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      const workflowResult: ReviewWorkflowResult = {
        results: [
          {
            checkItemContent: 'セキュリティ',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '問題なし',
            isError: false,
          },
        ],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      // 新項目のみworkflow実行
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.checkItemContents).toEqual(['セキュリティ']);

      // マージ結果（チェックリスト順）
      expect(result.results).toHaveLength(3);
      expect(result.results[0].checkItem.content).toBe('コードの可読性');
      expect(result.results[1].checkItem.content).toBe('テストカバレッジ');
      expect(result.results[2].checkItem.content).toBe('セキュリティ');
    });

    it('チェックリストから項目が削除された場合、残りの成功結果のみ投稿される', async () => {
      // 今回のチェックリストはコードの可読性のみ
      const command = createCommand({
        checklist: new Checklist([new CheckItem('コードの可読性')]),
      });
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回: 2項目とも成功
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良い',
          },
          {
            content: 'テストカバレッジ',
            ratingLabel: 'B',
            ratingDefinition: '概ね満たしている',
            comment: 'OK',
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      // workflowは実行されない
      expect(workflowRunner.run).not.toHaveBeenCalled();

      // コードの可読性のみ
      expect(result.results).toHaveLength(1);
      expect(result.results[0].checkItem.content).toBe('コードの可読性');
    });

    it('リトライ時にworkflowがエラー結果を返した場合、保持結果とエラー結果がマージされる', async () => {
      const command = createCommand();
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回: コードの可読性=成功、テストカバレッジ=エラー
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良い',
          },
          {
            content: 'テストカバレッジ',
            ratingLabel: '',
            ratingDefinition: '',
            comment: 'API error',
            isError: true,
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      // 再レビューもエラー
      const workflowResult: ReviewWorkflowResult = {
        results: [
          {
            checkItemContent: 'テストカバレッジ',
            ratingLabel: '',
            ratingDefinition: '',
            comment: '',
            isError: true,
            errorMessage: 'Timeout again',
          },
        ],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      expect(result.results).toHaveLength(2);
      expect(result.results[0].isError).toBe(false);
      expect(result.results[0].checkItem.content).toBe('コードの可読性');
      expect(result.results[1].isError).toBe(true);
      expect(result.results[1].checkItem.content).toBe('テストカバレッジ');
      expect(result.results[1].errorMessage).toBe('Timeout again');
    });

    it('マージ結果がチェックリスト順で並ぶ', async () => {
      const command = createCommand({
        checklist: new Checklist([
          new CheckItem('項目A'),
          new CheckItem('項目B'),
          new CheckItem('項目C'),
        ]),
      });
      const mrContext = createMrContext({ commitHash: 'same-hash' });

      // 前回: 項目A=成功、項目B=エラー、項目C=成功
      const priorComment = createAikataComment(
        [
          {
            content: '項目A',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: 'OK-A',
          },
          {
            content: '項目B',
            ratingLabel: '',
            ratingDefinition: '',
            comment: 'error',
            isError: true,
          },
          {
            content: '項目C',
            ratingLabel: 'B',
            ratingDefinition: '概ね満たしている',
            comment: 'OK-C',
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      // 再レビュー: 項目Bのみ
      const workflowResult: ReviewWorkflowResult = {
        results: [
          {
            checkItemContent: '項目B',
            ratingLabel: 'C',
            ratingDefinition: '満たしていない',
            comment: 'NEW-B',
            isError: false,
          },
        ],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      const result = await service.execute(command);

      // チェックリスト順: A→B→C
      expect(result.results.map((r) => r.checkItem.content)).toEqual(['項目A', '項目B', '項目C']);
      expect(result.results[0].comment).toBe('OK-A');
      expect(result.results[1].comment).toBe('NEW-B');
      expect(result.results[2].comment).toBe('OK-C');
    });

    it('コミットハッシュが異なる場合は通常のフルレビューが実行される（回帰テスト）', async () => {
      const command = createCommand();
      const mrContext = createMrContext({ commitHash: 'current-commit-hash' });
      const workflowResult = createWorkflowResult();

      // 前回のコミットハッシュは異なる
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良い',
          },
        ],
        'different-prior-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['new commit']);
      vi.mocked(mrGateway.getDiffSince).mockResolvedValue('new diff');
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      await service.execute(command);

      // フルレビュー: 全項目でworkflow実行
      expect(workflowRunner.run).toHaveBeenCalledOnce();
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.checkItemContents).toEqual(['コードの可読性', 'テストカバレッジ']);
      // prior contextが渡される
      expect(runCall.priorReviewResults).not.toBeNull();
      expect(runCall.priorCommitMessages).toEqual(['new commit']);
      expect(runCall.priorDiffSincePrior).toBe('new diff');
    });
  });

  describe('hiddenRatingLabels', () => {
    it('hiddenRatingLabels指定時、投稿コメントにメタデータ内の非表示結果が含まれる', async () => {
      const command = createCommand({
        reviewSettings: new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: null,
          commentFormat: '{comment}',
          ratings: [
            new Rating('A', '完全に満たしている'),
            new Rating('B', '概ね満たしている'),
            new Rating('C', '満たしていない'),
          ],
          hiddenRatingLabels: ['A'],
        }),
      });
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      await service.execute(command);

      const postedBody = vi.mocked(mrDiscussionGateway.postDiscussion).mock.calls[0][2];
      // A評定の「コードの可読性」はテーブルに表示されない
      expect(postedBody).not.toContain('| コードの可読性 | A | 良いコードです |');
      // B評定の「テストカバレッジ」はテーブルに表示される
      expect(postedBody).toContain('| テストカバレッジ | B | テストを追加してください |');
      // A評定の結果はメタデータに格納されている
      expect(postedBody).toContain('"hiddenResults"');
      expect(postedBody).toContain('"checkItemContent":"コードの可読性"');
    });

    it('過去のコメントにhiddenResultsがある場合、priorReviewResultsに含まれる', async () => {
      const ratings = [
        new Rating('A', '完全に満たしている'),
        new Rating('B', '概ね満たしている'),
        new Rating('C', '満たしていない'),
      ];
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      // 過去のコメントではA評定が非表示だった
      const priorComment = createAikataComment(
        [
          {
            content: 'コードの可読性',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良いです',
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
        ['A'], // A評定を非表示
      );

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
      vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      await service.execute(command);

      // 非表示だったA評定の結果もpriorReviewResultsに含まれる
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.priorReviewResults).toHaveLength(2);
      expect(runCall.priorReviewResults!.map((r) => r.checkItemContent)).toEqual([
        'テストカバレッジ',
        'コードの可読性',
      ]);
    });

    it('hiddenRatingLabelsが空の場合、従来と同じ動作をする', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);
      vi.mocked(mrDiscussionGateway.postDiscussion).mockResolvedValue(undefined);

      await service.execute(command);

      const postedBody = vi.mocked(mrDiscussionGateway.postDiscussion).mock.calls[0][2];
      // 全ての結果がテーブルに表示される
      expect(postedBody).toContain('| コードの可読性 | A | 良いコードです |');
      expect(postedBody).toContain('| テストカバレッジ | B | テストを追加してください |');
      // hiddenResultsはメタデータに含まれない
      expect(postedBody).not.toContain('"hiddenResults"');
    });
  });
});
