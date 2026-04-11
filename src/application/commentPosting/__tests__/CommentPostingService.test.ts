import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommentPostingService } from '../CommentPostingService.js';
import type { CommentPostingCommand } from '../CommentPostingCommand.js';
import type { MrDiscussionGateway } from '../../shared/port/gateway/MrDiscussionGateway.js';
import { ReviewResult } from '../../../domain/review/reviewResult/index.js';
import { Rating } from '../../../domain/review/rating/index.js';
import { CheckItem } from '../../../domain/review/checkItem/index.js';
import { CommentFormatter } from '../../shared/comment/index.js';
import type { QualityGateResult } from '../../../domain/review/qualityGate/index.js';

describe('CommentPostingService', () => {
  let mrDiscussionGateway: MrDiscussionGateway;
  let service: CommentPostingService;

  beforeEach(() => {
    mrDiscussionGateway = {
      getDiscussions: vi.fn(),
      postDiscussion: vi.fn().mockResolvedValue(undefined),
      postNote: vi.fn().mockResolvedValue(undefined),
    };
    service = new CommentPostingService(mrDiscussionGateway);
  });

  /**
   * テスト用のデフォルト品質ゲート結果（成功）
   */
  const passedQualityGateResult: QualityGateResult = {
    passed: true,
    violations: [],
  };

  /**
   * テスト用のデフォルト評定基準
   */
  const defaultRatings = [
    new Rating('A', '完全に満たしている'),
    new Rating('B', '概ね満たしている'),
    new Rating('C', '満たしていない'),
  ];

  /**
   * テスト用の基本コマンドを生成する
   */
  const createCommand = (
    overrides: Partial<CommentPostingCommand> = {},
  ): CommentPostingCommand => ({
    projectId: '123',
    mrIid: '42',
    results: [
      ReviewResult.success(
        new CheckItem('コードの可読性'),
        new Rating('A', '完全に満たしている'),
        '良いコードです',
      ),
      ReviewResult.success(
        new CheckItem('テストカバレッジ'),
        new Rating('B', '概ね満たしている'),
        '改善の余地あり',
      ),
    ],
    ratings: defaultRatings,
    commitHash: 'abc123',
    commitMessage: 'feat: add new feature',
    hiddenRatingLabels: [],
    qualityGateResult: passedQualityGateResult,
    ...overrides,
  });

  it('コメントがフォーマットされて投稿されること', async () => {
    const command = createCommand();
    const formatSpy = vi.spyOn(CommentFormatter, 'formatComment');

    await service.execute(command);

    // CommentFormatter.formatCommentが呼ばれたことを確認
    expect(formatSpy).toHaveBeenCalledOnce();
    // postDiscussionが呼ばれたことを確認（非表示なしの場合）
    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();
    // 投稿されたbodyがformatCommentの戻り値であることを確認
    const expectedBody = CommentFormatter.formatComment(
      command.results,
      command.ratings,
      command.commitHash,
      command.commitMessage,
      command.hiddenRatingLabels,
      command.qualityGateResult,
    );
    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledWith('123', '42', expectedBody);

    formatSpy.mockRestore();
  });

  it('全結果が非表示評定の場合は postNote が呼ばれること', async () => {
    const command = createCommand({
      results: [
        ReviewResult.success(
          new CheckItem('コードの可読性'),
          new Rating('A', '完全に満たしている'),
          '良いコードです',
        ),
        ReviewResult.success(
          new CheckItem('テストカバレッジ'),
          new Rating('A', '完全に満たしている'),
          '十分です',
        ),
      ],
      hiddenRatingLabels: ['A'],
    });

    await service.execute(command);

    expect(mrDiscussionGateway.postNote).toHaveBeenCalledOnce();
    expect(mrDiscussionGateway.postDiscussion).not.toHaveBeenCalled();
  });

  it('非表示でない結果がある場合は postDiscussion が呼ばれること', async () => {
    const command = createCommand({
      results: [
        ReviewResult.success(
          new CheckItem('コードの可読性'),
          new Rating('A', '完全に満たしている'),
          '良いコードです',
        ),
        ReviewResult.success(
          new CheckItem('テストカバレッジ'),
          new Rating('B', '概ね満たしている'),
          '改善の余地あり',
        ),
      ],
      hiddenRatingLabels: ['A'],
    });

    await service.execute(command);

    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();
    expect(mrDiscussionGateway.postNote).not.toHaveBeenCalled();
  });

  it('正しい引数で CommentFormatter.formatComment が呼ばれること', async () => {
    const results = [
      ReviewResult.success(
        new CheckItem('コードの可読性'),
        new Rating('A', '完全に満たしている'),
        '良いコードです',
      ),
    ];
    const ratings = [new Rating('A', '完全に満たしている'), new Rating('B', '概ね満たしている')];
    const qualityGateResult: QualityGateResult = {
      passed: false,
      violations: [{ ratingLabel: 'C', threshold: 1, actualCount: 2 }],
    };

    const command = createCommand({
      projectId: '456',
      mrIid: '99',
      results,
      ratings,
      commitHash: 'def456',
      commitMessage: 'fix: bug fix',
      hiddenRatingLabels: ['A'],
      qualityGateResult,
    });

    const formatSpy = vi.spyOn(CommentFormatter, 'formatComment');

    await service.execute(command);

    expect(formatSpy).toHaveBeenCalledWith(
      results,
      ratings,
      'def456',
      'fix: bug fix',
      ['A'],
      qualityGateResult,
    );

    formatSpy.mockRestore();
  });

  it('hiddenRatingLabelsが空の場合は postDiscussion が呼ばれること', async () => {
    const command = createCommand({
      hiddenRatingLabels: [],
    });

    await service.execute(command);

    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledOnce();
    expect(mrDiscussionGateway.postNote).not.toHaveBeenCalled();
  });

  it('投稿先にprojectIdとmrIidが正しく渡されること', async () => {
    const command = createCommand({
      projectId: '789',
      mrIid: '55',
    });

    await service.execute(command);

    expect(mrDiscussionGateway.postDiscussion).toHaveBeenCalledWith(
      '789',
      '55',
      expect.any(String),
    );
  });
});
