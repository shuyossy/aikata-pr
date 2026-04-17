import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewExecutionService } from '../ReviewExecutionService.js';
import type {
  ReviewWorkflowRunner,
  ReviewWorkflowResult,
} from '../../../shared/port/workflow/index.js';
import type { ReviewExecutionCommand } from '../ReviewExecutionCommand.js';
import type { MrGateway } from '../../../shared/port/gateway/index.js';
import type {
  MrDiscussionGateway,
  MrComment,
  SuggestDiscussion,
} from '../../../shared/port/gateway/index.js';
import type { ProjectTreeGateway } from '../../../shared/port/gateway/index.js';
import { MrContext } from '../../../../domain/review/mrContext/index.js';
import { CheckItem } from '../../../../domain/review/checkItem/index.js';
import { Checklist } from '../../../../domain/review/checklist/index.js';
import { Rating } from '../../../../domain/review/rating/index.js';
import { ReviewSettings } from '../../../../domain/review/reviewSettings/index.js';
import { ReviewResult } from '../../../../domain/review/reviewResult/index.js';
import { QualityGate } from '../../../../domain/review/qualityGate/index.js';
import { CommentFormatter } from '../../../shared/comment/index.js';
import type { TokenCounter } from '../../../shared/port/tokenCounter/index.js';

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
    baseSha: 'base-sha',
    headSha: 'head-sha',
    startSha: 'start-sha',
    ...overrides,
  });
}

// ヘルパー: テスト用のReviewExecutionCommandを生成
function createCommand(overrides?: Partial<ReviewExecutionCommand>): ReviewExecutionCommand {
  return {
    userId: 'test-user',
    projectId: 'project-1',
    mrIid: '42',
    gitlabToken: 'test-gitlab-token',
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
      suggestEnabledRatingLabels: ['C'],
      qualityGate: QualityGate.none(),
    }),
    skillsPaths: [],
    projectDir: '/test/project',
    aiApiKey: 'test-api-key',
    aiApiEndpointUrl: 'https://api.example.com',
    aiModelName: 'openai/o4-mini',
    treeMaxDepth: undefined,
    commentLanguage: 'Japanese',
    openaiReasoningEffort: undefined,
    maxContextLength: undefined,
    suggestEnabledRatingLabels: ['C'],
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
    suggestions: [],
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
    { passed: true, violations: [] },
  );
  return { id: 1, body, createdAt };
}

describe('ReviewExecutionService', () => {
  let mrGateway: MrGateway;
  let mrDiscussionGateway: MrDiscussionGateway;
  let workflowRunner: ReviewWorkflowRunner;
  let projectTreeGateway: ProjectTreeGateway;
  let service: ReviewExecutionService;

  beforeEach(() => {
    mrGateway = {
      getMrContext: vi.fn(),
      getCommitsSince: vi.fn(),
      getDiffSince: vi.fn(),
    };
    mrDiscussionGateway = {
      getReviewDiscussions: vi.fn(),
      postReviewDiscussion: vi.fn(),
      postNote: vi.fn(),
      getSuggestDiscussions: vi.fn().mockResolvedValue([]),
      postSuggestDiscussion: vi.fn().mockResolvedValue(undefined),
      resolveDiscussion: vi.fn().mockResolvedValue(undefined),
    };
    workflowRunner = {
      run: vi.fn(),
    };
    projectTreeGateway = {
      getTree: vi.fn().mockResolvedValue('src/\n  index.ts'),
    };
    const tokenCounter: TokenCounter = {
      countTokens: vi.fn().mockReturnValue(100),
    };
    service = new ReviewExecutionService(
      mrGateway,
      mrDiscussionGateway,
      workflowRunner,
      projectTreeGateway,
      tokenCounter,
    );
  });

  it('正常系: MRコンテキスト取得→Workflow実行→レビュー結果返却の全フローが実行される', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]); // 過去コメントなし
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    const result = await service.execute(command);

    // MRコンテキスト取得
    expect(mrGateway.getMrContext).toHaveBeenCalledWith('project-1', '42');
    // 過去コメント取得
    expect(mrDiscussionGateway.getReviewDiscussions).toHaveBeenCalledWith('project-1', '42');
    // Workflow実行
    expect(workflowRunner.run).toHaveBeenCalledOnce();

    // 結果の検証
    expect(result.results).toHaveLength(2);
    expect(result.commitHash).toBe('current-commit-hash');
    expect(result.commitMessage).toBe('feat: test commit message');
    expect(result.results[0].checkItem.content).toBe('コードの可読性');
    expect(result.results[0].rating.label).toBe('A');
    expect(result.results[1].checkItem.content).toBe('テストカバレッジ');
    expect(result.results[1].rating.label).toBe('B');
  });

  it('コメント投稿や品質ゲート評価を実行しない', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    const result = await service.execute(command);

    // コメント投稿は呼ばれない
    expect(mrDiscussionGateway.postReviewDiscussion).not.toHaveBeenCalled();
    expect(mrDiscussionGateway.postNote).not.toHaveBeenCalled();

    // 品質ゲート関連のプロパティが存在しない
    expect(result).not.toHaveProperty('commentPosted');
    expect(result).not.toHaveProperty('qualityGatePassed');
    expect(result).not.toHaveProperty('allResultsAreErrors');
  });

  it('commitMessageが返却される', async () => {
    const command = createCommand();
    const mrContext = createMrContext({ commitMessage: 'fix: important bug fix' });
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    const result = await service.execute(command);

    expect(result.commitMessage).toBe('fix: important bug fix');
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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue([
      'fix: improve code',
      'test: add tests',
    ]);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('diff since prior');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]); // 過去コメントなし
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    await service.execute(command);

    // 「セキュリティ」は除外され、「コードの可読性」と「テストカバレッジ」のみ
    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.priorReviewResults).toHaveLength(2);
    expect(runCall.priorReviewResults!.map((r) => r.checkItemContent)).toEqual([
      'コードの可読性',
      'テストカバレッジ',
    ]);
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
      suggestions: [],
    };

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    const result = await service.execute(command);

    expect(result.results).toHaveLength(2);
    expect(result.results[0].isError).toBe(false);
    expect(result.results[1].isError).toBe(true);
    expect(result.results[1].errorMessage).toBe('AI processing timeout');
  });

  it('フルレビューで全てのレビュー結果がエラーの場合でもコメント投稿は呼ばれない', async () => {
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
      suggestions: [],
    };

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    const result = await service.execute(command);

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.isError)).toBe(true);
    // コメント投稿は呼ばれない（ReviewExecutionServiceの責務外）
    expect(mrDiscussionGateway.postReviewDiscussion).not.toHaveBeenCalled();
    expect(mrDiscussionGateway.postNote).not.toHaveBeenCalled();
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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([
      olderComment,
      newerComment,
    ]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['new commit']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('new diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([
      aikataComment,
      normalComment,
    ]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([aikataComment]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
      suggestions: [],
    };

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    await expect(service.execute(command)).rejects.toThrow('Check item not found: 存在しない項目');
  });

  it('Workflow実行時に正しいパラメータが渡される', async () => {
    const command = createCommand();
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
    expect(runCall.projectId).toBe('project-1');
    expect(runCall.projectDir).toBe('/test/project');
    expect(runCall.openaiReasoningEffort).toBeUndefined();
  });

  it('openaiReasoningEffort指定時にWorkflowに伝播されること', async () => {
    const command = createCommand({ openaiReasoningEffort: 'high' });
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    await service.execute(command);

    const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
    expect(runCall.openaiReasoningEffort).toBe('high');
  });

  it('ProjectTreeGateway.getTreeが正しい引数で呼ばれる', async () => {
    const command = createCommand({ treeMaxDepth: 3 });
    const mrContext = createMrContext();
    const workflowResult = createWorkflowResult();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

    await service.execute(command);

    expect(projectTreeGateway.getTree).toHaveBeenCalledWith('/test/project', { maxDepth: 3 });
  });

  it('ProjectTreeGateway.getTreeのエラーが伝播される', async () => {
    const command = createCommand();

    vi.mocked(mrGateway.getMrContext).mockResolvedValue(createMrContext());
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
    vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
    vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
    vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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

    it('全項目が前回成功の場合、workflowは実行されず前回結果がそのまま返却される', async () => {
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
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);

      const result = await service.execute(command);

      // workflowは実行されない
      expect(workflowRunner.run).not.toHaveBeenCalled();

      // コメント投稿は呼ばれない（ReviewExecutionServiceの責務外）
      expect(mrDiscussionGateway.postReviewDiscussion).not.toHaveBeenCalled();
      expect(mrDiscussionGateway.postNote).not.toHaveBeenCalled();

      // 結果が前回と同じ
      expect(result.results).toHaveLength(2);
      expect(result.results[0].checkItem.content).toBe('コードの可読性');
      expect(result.results[0].rating.label).toBe('A');
      expect(result.results[0].comment).toBe('良いコードです');
      expect(result.results[1].checkItem.content).toBe('テストカバレッジ');
      expect(result.results[1].rating.label).toBe('B');
      expect(result.results[1].comment).toBe('もう少し');
      expect(result.commitHash).toBe('same-hash');
      expect(result.commitMessage).toBe('feat: test commit message');
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
        suggestions: [],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      const result = await service.execute(command);

      // 全項目でworkflow実行
      expect(workflowRunner.run).toHaveBeenCalledOnce();
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.checkItemContents).toEqual(['コードの可読性', 'テストカバレッジ']);

      expect(result.results).toHaveLength(2);
    });

    it('リトライ時にワークフロー再実行後も全てエラーの場合、結果が正しく返却される', async () => {
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
        suggestions: [],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      const result = await service.execute(command);

      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.isError)).toBe(true);
      // コメント投稿は呼ばれない（ReviewExecutionServiceの責務外）
      expect(mrDiscussionGateway.postReviewDiscussion).not.toHaveBeenCalled();
      expect(mrDiscussionGateway.postNote).not.toHaveBeenCalled();
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
        suggestions: [],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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

    it('チェックリストから項目が削除された場合、残りの成功結果のみ返却される', async () => {
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
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);

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
        suggestions: [],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
        suggestions: [],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['new commit']);
      vi.mocked(mrGateway.getDiffSince).mockResolvedValue('new diff');
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

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
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(mrGateway.getCommitsSince).mockResolvedValue(['fix: update']);
      vi.mocked(mrGateway.getDiffSince).mockResolvedValue('some diff');
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      // 非表示だったA評定の結果もpriorReviewResultsに含まれる
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.priorReviewResults).toHaveLength(2);
      expect(runCall.priorReviewResults!.map((r) => r.checkItemContent)).toEqual([
        'テストカバレッジ',
        'コードの可読性',
      ]);
    });
  });

  describe('suggest関連', () => {
    it('getSuggestDiscussionsがexecute内で呼び出される', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      expect(mrDiscussionGateway.getSuggestDiscussions).toHaveBeenCalledWith('project-1', '42');
    });

    it('activeSuggestsフィルタリング: hasChangedSinceNote=trueのものは除外される', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      const suggestDiscussions: SuggestDiscussion[] = [
        {
          discussionId: 'disc-1',
          checkItemContent: 'コードの可読性',
          filePath: 'src/app.ts',
          originalCode: 'old code',
          suggestedCode: 'new code',
          hasChangedSinceNote: true, // 変更済み → 除外
        },
        {
          discussionId: 'disc-2',
          checkItemContent: 'テストカバレッジ',
          filePath: 'src/test.ts',
          originalCode: 'old test',
          suggestedCode: 'new test',
          hasChangedSinceNote: false, // 未変更 → アクティブ
        },
      ];

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(mrDiscussionGateway.getSuggestDiscussions).mockResolvedValue(suggestDiscussions);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      // hasChangedSinceNote=falseかつチェックリストに含まれる項目のみがactiveSuggestsに残る
      expect(runCall.activeSuggests).toHaveLength(1);
      expect(runCall.activeSuggests![0].checkItemContent).toBe('テストカバレッジ');
      expect(runCall.activeSuggests![0].filePath).toBe('src/test.ts');
      expect(runCall.activeSuggests![0].originalCode).toBe('old test');
      expect(runCall.activeSuggests![0].suggestedCode).toBe('new test');
    });

    it('activeSuggestsフィルタリング: 現在のチェックリストに含まれないcheckItemContentは除外される', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      const suggestDiscussions: SuggestDiscussion[] = [
        {
          discussionId: 'disc-1',
          checkItemContent: '存在しない項目', // チェックリストに含まれない
          filePath: 'src/app.ts',
          originalCode: 'old code',
          suggestedCode: 'new code',
          hasChangedSinceNote: false,
        },
      ];

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(mrDiscussionGateway.getSuggestDiscussions).mockResolvedValue(suggestDiscussions);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.activeSuggests).toHaveLength(0);
    });

    it('suggestsToResolve: hasChangedSinceNote=trueまたはチェックリストに含まれないものが対象になる', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      const suggestDiscussions: SuggestDiscussion[] = [
        {
          discussionId: 'disc-1',
          checkItemContent: 'コードの可読性',
          filePath: 'src/app.ts',
          originalCode: 'old code',
          suggestedCode: 'new code',
          hasChangedSinceNote: true, // 変更済み → resolve対象
        },
        {
          discussionId: 'disc-2',
          checkItemContent: 'テストカバレッジ',
          filePath: 'src/test.ts',
          originalCode: 'old test',
          suggestedCode: 'new test',
          hasChangedSinceNote: false, // 未変更かつチェックリストに含まれる → アクティブ
        },
        {
          discussionId: 'disc-3',
          checkItemContent: '削除された項目',
          filePath: 'src/old.ts',
          originalCode: 'deleted code',
          suggestedCode: 'suggested code',
          hasChangedSinceNote: false, // 未変更だがチェックリストに含まれない → resolve対象
        },
      ];

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(mrDiscussionGateway.getSuggestDiscussions).mockResolvedValue(suggestDiscussions);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      const result = await service.execute(command);

      // suggestsToResolveのdiscussionIdが返却される
      expect(result.suggestsToResolve).toEqual(['disc-1', 'disc-3']);
    });

    it('DtoにbaseSha, headSha, startShaが含まれる', async () => {
      const command = createCommand();
      const mrContext = createMrContext({
        baseSha: 'test-base-sha',
        headSha: 'test-head-sha',
        startSha: 'test-start-sha',
      });
      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      const result = await service.execute(command);

      expect(result.baseSha).toBe('test-base-sha');
      expect(result.headSha).toBe('test-head-sha');
      expect(result.startSha).toBe('test-start-sha');
    });

    it('Dtoにsuggestionsが空配列で含まれる（ワークフロー結果のsuggestionsが空の場合）', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult({ suggestions: [] });

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      const result = await service.execute(command);

      expect(result.suggestions).toEqual([]);
    });

    it('ワークフローパラメータにsuggest関連フィールドが含まれる', async () => {
      const command = createCommand({ suggestEnabledRatingLabels: ['B', 'C'] });
      const mrContext = createMrContext({ diff: 'full diff content' });
      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.suggestEnabledRatingLabels).toEqual(['B', 'C']);
      expect(runCall.activeSuggests).toEqual([]);
      expect(runCall.suggestResultFilePath).toMatch(/aikata-suggest-/);
      expect(runCall.fullMrDiff).toBe('full diff content');
    });

    it('suggestEnabledRatingLabelsが空配列の場合、activeSuggestsはnullになる', async () => {
      const command = createCommand({ suggestEnabledRatingLabels: [] });
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.suggestEnabledRatingLabels).toEqual([]);
      expect(runCall.activeSuggests).toBeNull();
    });

    it('リトライ実行時もsuggest関連フィールドがワークフローパラメータに含まれる', async () => {
      const ratings = [
        new Rating('A', '完全に満たしている'),
        new Rating('B', '概ね満たしている'),
        new Rating('C', '満たしていない'),
      ];
      const command = createCommand({ suggestEnabledRatingLabels: ['C'] });
      const mrContext = createMrContext({ commitHash: 'same-hash', diff: 'full diff' });

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
            comment: 'error',
            isError: true,
          },
        ],
        'same-hash',
        ratings,
        '2026-01-01T00:00:00Z',
      );

      const workflowResult: ReviewWorkflowResult = {
        results: [
          {
            checkItemContent: 'テストカバレッジ',
            ratingLabel: 'B',
            ratingDefinition: '概ね満たしている',
            comment: 'OK',
            isError: false,
          },
        ],
        suggestions: [],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.suggestEnabledRatingLabels).toEqual(['C']);
      expect(runCall.fullMrDiff).toBe('full diff');
      expect(runCall.suggestResultFilePath).toMatch(/aikata-suggest-/);
    });

    it('ワークフローがsuggestionsを返す場合、DtoのsuggestionsにResolvedSuggestionとして含まれる', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult: ReviewWorkflowResult = {
        results: [
          {
            checkItemContent: 'コードの可読性',
            ratingLabel: 'C',
            ratingDefinition: '満たしていない',
            comment: '改善が必要',
            isError: false,
          },
          {
            checkItemContent: 'テストカバレッジ',
            ratingLabel: 'A',
            ratingDefinition: '完全に満たしている',
            comment: '良い',
            isError: false,
          },
        ],
        suggestions: [
          {
            checkItemContent: 'コードの可読性',
            filePath: 'src/app.ts',
            originalCode: 'console.log(err)',
            suggestedCode: 'logger.error(err)',
            comment: 'loggerを使用してください',
            newLine: 10,
            linesAbove: 0,
            linesBelow: 0,
            oldPath: 'src/app.ts',
            newPath: 'src/app.ts',
          },
        ],
      };

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      const result = await service.execute(command);

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].suggestion.checkItemContent).toBe('コードの可読性');
      expect(result.suggestions[0].suggestion.filePath).toBe('src/app.ts');
      expect(result.suggestions[0].suggestion.originalCode).toBe('console.log(err)');
      expect(result.suggestions[0].suggestion.suggestedCode).toBe('logger.error(err)');
      expect(result.suggestions[0].suggestion.comment).toBe('loggerを使用してください');
      expect(result.suggestions[0].newLine).toBe(10);
      expect(result.suggestions[0].linesAbove).toBe(0);
      expect(result.suggestions[0].linesBelow).toBe(0);
      expect(result.suggestions[0].oldPath).toBe('src/app.ts');
      expect(result.suggestions[0].newPath).toBe('src/app.ts');
    });

    it('リトライ実行時（全項目成功で再レビュー不要）もDtoにsuggest関連フィールドが含まれる', async () => {
      const ratings = [
        new Rating('A', '完全に満たしている'),
        new Rating('B', '概ね満たしている'),
        new Rating('C', '満たしていない'),
      ];
      const command = createCommand();
      const mrContext = createMrContext({
        commitHash: 'same-hash',
        baseSha: 'b-sha',
        headSha: 'h-sha',
        startSha: 's-sha',
      });

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
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([priorComment]);

      const result = await service.execute(command);

      // workflowは実行されない
      expect(workflowRunner.run).not.toHaveBeenCalled();

      // Dtoにsuggest関連フィールドが含まれる
      expect(result.suggestions).toEqual([]);
      expect(result.baseSha).toBe('b-sha');
      expect(result.headSha).toBe('h-sha');
      expect(result.startSha).toBe('s-sha');
    });

    it('suggestResultファイルのクリーンアップが実行される', async () => {
      const command = createCommand();
      const mrContext = createMrContext();
      const workflowResult = createWorkflowResult();

      vi.mocked(mrGateway.getMrContext).mockResolvedValue(mrContext);
      vi.mocked(mrDiscussionGateway.getReviewDiscussions).mockResolvedValue([]);
      vi.mocked(workflowRunner.run).mockResolvedValue(workflowResult);

      await service.execute(command);

      // suggestResultFilePathが一時ファイルとして生成されたことを確認（ワークフローパラメータから）
      const runCall = vi.mocked(workflowRunner.run).mock.calls[0][0];
      expect(runCall.suggestResultFilePath).toBeDefined();
      expect(runCall.suggestResultFilePath).toContain('aikata-suggest-');
    });
  });
});
