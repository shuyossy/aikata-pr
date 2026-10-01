import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommentPostingService } from '../CommentPostingService.js';
import type { CommentPostingCommand } from '../CommentPostingCommand.js';
import type { MrDiscussionGateway } from '../../../shared/port/gateway/MrDiscussionGateway.js';
import { ReviewResult } from '../../../../domain/review/reviewResult/index.js';
import { Rating } from '../../../../domain/review/rating/index.js';
import { CheckItem } from '../../../../domain/review/checkItem/index.js';
import { CommentFormatter, SuggestCommentFormatter } from '../../../shared/comment/index.js';
import type { QualityGateResult } from '../../../../domain/review/qualityGate/index.js';
import { ResolvedSuggestion, Suggestion } from '../../../../domain/review/suggestion/index.js';
import { initializeLogger, resetLogger } from '../../../../lib/logger.js';

describe('CommentPostingService', () => {
  let mrDiscussionGateway: MrDiscussionGateway;
  let service: CommentPostingService;

  beforeEach(() => {
    initializeLogger({ userId: 'test-user', level: 'silent' });
    mrDiscussionGateway = {
      getReviewDiscussions: vi.fn(),
      postReviewDiscussion: vi.fn().mockResolvedValue(undefined),
      postNote: vi.fn().mockResolvedValue(undefined),
      getSuggestDiscussions: vi.fn().mockResolvedValue([]),
      postSuggestDiscussion: vi.fn().mockResolvedValue(undefined),
      replyToDiscussion: vi.fn().mockResolvedValue(undefined),
      resolveDiscussion: vi.fn().mockResolvedValue(undefined),
    };
    service = new CommentPostingService(mrDiscussionGateway);
  });

  afterEach(() => {
    resetLogger();
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
    suggestions: [],
    suggestResolveEntries: [],
    baseSha: 'base-sha-000',
    headSha: 'head-sha-111',
    startSha: 'start-sha-222',
    mrCommentTitle: 'AIKATA-PR レビュー結果',
    reviewCommentLayout: 'table',
    checkItemDisplayContents: new Map(),
    ...overrides,
  });

  it('コメントがフォーマットされて投稿されること', async () => {
    const command = createCommand();
    const formatSpy = vi.spyOn(CommentFormatter, 'formatComment');

    await service.execute(command);

    // CommentFormatter.formatCommentが呼ばれたことを確認
    expect(formatSpy).toHaveBeenCalledOnce();
    // postDiscussionが呼ばれたことを確認（非表示なしの場合）
    expect(mrDiscussionGateway.postReviewDiscussion).toHaveBeenCalledOnce();
    // 投稿されたbodyがformatCommentの戻り値であることを確認
    const expectedBody = CommentFormatter.formatComment({
      results: command.results,
      ratings: command.ratings,
      commitHash: command.commitHash,
      commitMessage: command.commitMessage,
      hiddenRatingLabels: command.hiddenRatingLabels,
      qualityGateResult: command.qualityGateResult,
      mrCommentTitle: command.mrCommentTitle,
      layout: 'table',
      checkItemDisplayContents: new Map(),
    });
    expect(mrDiscussionGateway.postReviewDiscussion).toHaveBeenCalledWith(
      '123',
      '42',
      expectedBody,
    );

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
    expect(mrDiscussionGateway.postReviewDiscussion).not.toHaveBeenCalled();
  });

  it('非表示でない結果がある場合は postReviewDiscussion が呼ばれること', async () => {
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

    expect(mrDiscussionGateway.postReviewDiscussion).toHaveBeenCalledOnce();
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

    expect(formatSpy).toHaveBeenCalledWith({
      results,
      ratings,
      commitHash: 'def456',
      commitMessage: 'fix: bug fix',
      hiddenRatingLabels: ['A'],
      qualityGateResult,
      mrCommentTitle: 'AIKATA-PR レビュー結果',
      layout: 'table',
      checkItemDisplayContents: command.checkItemDisplayContents,
    });

    formatSpy.mockRestore();
  });

  it('mrCommentTitleがCommentFormatterに透過的に渡されること', async () => {
    const command = createCommand({ mrCommentTitle: 'API基盤チェック' });
    const formatSpy = vi.spyOn(CommentFormatter, 'formatComment');

    await service.execute(command);

    expect(formatSpy).toHaveBeenCalledWith({
      results: command.results,
      ratings: command.ratings,
      commitHash: command.commitHash,
      commitMessage: command.commitMessage,
      hiddenRatingLabels: command.hiddenRatingLabels,
      qualityGateResult: command.qualityGateResult,
      mrCommentTitle: 'API基盤チェック',
      layout: 'table',
      checkItemDisplayContents: command.checkItemDisplayContents,
    });

    formatSpy.mockRestore();
  });

  it('hiddenRatingLabelsが空の場合は postReviewDiscussion が呼ばれること', async () => {
    const command = createCommand({
      hiddenRatingLabels: [],
    });

    await service.execute(command);

    expect(mrDiscussionGateway.postReviewDiscussion).toHaveBeenCalledOnce();
    expect(mrDiscussionGateway.postNote).not.toHaveBeenCalled();
  });

  it('投稿先にprojectIdとmrIidが正しく渡されること', async () => {
    const command = createCommand({
      projectId: '789',
      mrIid: '55',
    });

    await service.execute(command);

    expect(mrDiscussionGateway.postReviewDiscussion).toHaveBeenCalledWith(
      '789',
      '55',
      expect.any(String),
    );
  });

  describe('suggest投稿・解決', () => {
    /**
     * テスト用のResolvedSuggestionを生成する
     */
    const createResolvedSuggestion = (
      overrides: Partial<{
        checkItemContent: string;
        filePath: string;
        originalCode: string;
        suggestedCode: string;
        comment: string;
        newLine: number;
        linesAbove: number;
        linesBelow: number;
        oldPath: string;
        newPath: string;
      }> = {},
    ): ResolvedSuggestion => {
      const defaults = {
        checkItemContent: 'コードの可読性',
        filePath: 'src/main.ts',
        originalCode: 'const x = 1;',
        suggestedCode: 'const x = 2;',
        comment: '値を修正してください',
        newLine: 10,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/main.ts',
        newPath: 'src/main.ts',
      };
      const merged = { ...defaults, ...overrides };
      return new ResolvedSuggestion({
        suggestion: new Suggestion({
          checkItemContent: merged.checkItemContent,
          filePath: merged.filePath,
          originalCode: merged.originalCode,
          suggestedCode: merged.suggestedCode,
          comment: merged.comment,
        }),
        newLine: merged.newLine,
        linesAbove: merged.linesAbove,
        linesBelow: merged.linesBelow,
        oldPath: merged.oldPath,
        newPath: merged.newPath,
      });
    };

    it('suggestResolveEntriesの各エントリに対して理由投稿後にresolveDiscussionが呼ばれること', async () => {
      const command = createCommand({
        suggestResolveEntries: [
          { discussionId: 'disc-1', reason: 'Diff updated.' },
          { discussionId: 'disc-2', reason: 'Overlapping suggest.' },
          { discussionId: 'disc-3', reason: 'Check item removed.' },
        ],
      });

      await service.execute(command);

      // 理由の投稿
      expect(mrDiscussionGateway.replyToDiscussion).toHaveBeenCalledTimes(3);
      expect(mrDiscussionGateway.replyToDiscussion).toHaveBeenNthCalledWith(
        1,
        '123',
        '42',
        'disc-1',
        'Diff updated.',
      );
      expect(mrDiscussionGateway.replyToDiscussion).toHaveBeenNthCalledWith(
        2,
        '123',
        '42',
        'disc-2',
        'Overlapping suggest.',
      );
      expect(mrDiscussionGateway.replyToDiscussion).toHaveBeenNthCalledWith(
        3,
        '123',
        '42',
        'disc-3',
        'Check item removed.',
      );

      // resolve
      expect(mrDiscussionGateway.resolveDiscussion).toHaveBeenCalledTimes(3);
      expect(mrDiscussionGateway.resolveDiscussion).toHaveBeenNthCalledWith(
        1,
        '123',
        '42',
        'disc-1',
      );
      expect(mrDiscussionGateway.resolveDiscussion).toHaveBeenNthCalledWith(
        2,
        '123',
        '42',
        'disc-2',
      );
      expect(mrDiscussionGateway.resolveDiscussion).toHaveBeenNthCalledWith(
        3,
        '123',
        '42',
        'disc-3',
      );
    });

    it('suggestionsの各要素に対してpostSuggestDiscussionが正しい引数で呼ばれること', async () => {
      const suggestion1 = createResolvedSuggestion({
        checkItemContent: '可読性',
        filePath: 'src/a.ts',
        originalCode: 'let a = 1;',
        suggestedCode: 'const a = 1;',
        comment: 'letではなくconstを使ってください',
        newLine: 5,
        linesAbove: 0,
        linesBelow: 0,
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
      });
      const suggestion2 = createResolvedSuggestion({
        checkItemContent: 'パフォーマンス',
        filePath: 'src/b.ts',
        originalCode: 'arr.forEach(fn);',
        suggestedCode: 'for (const item of arr) { fn(item); }',
        comment: 'forEachの代わりにfor...ofを使ってください',
        newLine: 20,
        linesAbove: 1,
        linesBelow: 2,
        oldPath: 'src/b-old.ts',
        newPath: 'src/b.ts',
      });

      const command = createCommand({
        suggestions: [suggestion1, suggestion2],
        baseSha: 'base-aaa',
        headSha: 'head-bbb',
        startSha: 'start-ccc',
      });

      await service.execute(command);

      expect(mrDiscussionGateway.postSuggestDiscussion).toHaveBeenCalledTimes(2);

      const expectedBody1 = SuggestCommentFormatter.format(suggestion1, new Map());
      expect(mrDiscussionGateway.postSuggestDiscussion).toHaveBeenNthCalledWith(
        1,
        '123',
        '42',
        expectedBody1,
        {
          baseSha: 'base-aaa',
          headSha: 'head-bbb',
          startSha: 'start-ccc',
          oldPath: 'src/a.ts',
          newPath: 'src/a.ts',
          newLine: 5,
        },
      );

      const expectedBody2 = SuggestCommentFormatter.format(suggestion2, new Map());
      expect(mrDiscussionGateway.postSuggestDiscussion).toHaveBeenNthCalledWith(
        2,
        '123',
        '42',
        expectedBody2,
        {
          baseSha: 'base-aaa',
          headSha: 'head-bbb',
          startSha: 'start-ccc',
          oldPath: 'src/b-old.ts',
          newPath: 'src/b.ts',
          newLine: 20,
        },
      );
    });

    it('postSuggestDiscussionが失敗しても残りのsuggestは投稿され、execute全体がエラーにならないこと', async () => {
      const suggestion1 = createResolvedSuggestion({
        checkItemContent: '失敗する提案',
        filePath: 'src/fail.ts',
        originalCode: 'fail code',
        suggestedCode: 'fixed code',
        comment: 'この提案は失敗する',
        newLine: 5,
      });
      const suggestion2 = createResolvedSuggestion({
        checkItemContent: '成功する提案',
        filePath: 'src/success.ts',
        originalCode: 'old code',
        suggestedCode: 'new code',
        comment: '成功する提案',
        newLine: 15,
      });

      // 1件目で例外を投げ、2件目は成功
      vi.mocked(mrDiscussionGateway.postSuggestDiscussion)
        .mockRejectedValueOnce(new Error('GitLab API error: 422'))
        .mockResolvedValueOnce(undefined);

      const command = createCommand({
        suggestions: [suggestion1, suggestion2],
      });

      // execute全体がエラーにならないこと
      await expect(service.execute(command)).resolves.not.toThrow();

      // 2回呼ばれていること（1件目の失敗後も2件目が試行される）
      expect(mrDiscussionGateway.postSuggestDiscussion).toHaveBeenCalledTimes(2);
    });

    it('suggestionsとsuggestResolveEntriesが空の場合はsuggest関連メソッドが呼ばれないこと', async () => {
      const command = createCommand({
        suggestions: [],
        suggestResolveEntries: [],
      });

      await service.execute(command);

      expect(mrDiscussionGateway.replyToDiscussion).not.toHaveBeenCalled();
      expect(mrDiscussionGateway.resolveDiscussion).not.toHaveBeenCalled();
      expect(mrDiscussionGateway.postSuggestDiscussion).not.toHaveBeenCalled();
    });

    it('既存のレビュー投稿ロジックとsuggest投稿が両方正しく動作すること', async () => {
      const suggestion = createResolvedSuggestion();
      const command = createCommand({
        suggestions: [suggestion],
        suggestResolveEntries: [{ discussionId: 'old-disc-1', reason: 'Overlap.' }],
      });

      await service.execute(command);

      // 既存のレビューコメント投稿が行われていること
      expect(mrDiscussionGateway.postReviewDiscussion).toHaveBeenCalledOnce();
      // 旧suggestに理由が投稿されていること
      expect(mrDiscussionGateway.replyToDiscussion).toHaveBeenCalledOnce();
      expect(mrDiscussionGateway.replyToDiscussion).toHaveBeenCalledWith(
        '123',
        '42',
        'old-disc-1',
        'Overlap.',
      );
      // 旧suggestのresolveが行われていること
      expect(mrDiscussionGateway.resolveDiscussion).toHaveBeenCalledOnce();
      expect(mrDiscussionGateway.resolveDiscussion).toHaveBeenCalledWith('123', '42', 'old-disc-1');
      // 新suggestの投稿が行われていること
      expect(mrDiscussionGateway.postSuggestDiscussion).toHaveBeenCalledOnce();
    });
  });

  describe('レイアウト・表示用contentの伝播', () => {
    it('reviewCommentLayoutがCommentFormatterに透過的に渡されること', async () => {
      const command = createCommand({ reviewCommentLayout: 'sections' });
      const formatSpy = vi.spyOn(CommentFormatter, 'formatComment');

      await service.execute(command);

      expect(formatSpy).toHaveBeenCalledWith(expect.objectContaining({ layout: 'sections' }));

      formatSpy.mockRestore();
    });

    it('checkItemDisplayContentsがCommentFormatterに透過的に渡されること', async () => {
      const displayContents = new Map([['コードの可読性', '可読性']]);
      const command = createCommand({ checkItemDisplayContents: displayContents });
      const formatSpy = vi.spyOn(CommentFormatter, 'formatComment');

      await service.execute(command);

      expect(formatSpy).toHaveBeenCalledWith(
        expect.objectContaining({ checkItemDisplayContents: displayContents }),
      );

      formatSpy.mockRestore();
    });

    it('sectionsレイアウトを指定した場合は項目ごとの折りたたみ付きのコメントが投稿されること', async () => {
      const command = createCommand({ reviewCommentLayout: 'sections' });

      await service.execute(command);

      const body = vi.mocked(mrDiscussionGateway.postReviewDiscussion).mock.calls[0]![2];
      expect(body).toContain('| # | チェック項目 | 評定 |');
      expect(body).toContain('<summary>#1</summary>');
      expect(body).toContain('**評定: A**');
    });
  });
});
