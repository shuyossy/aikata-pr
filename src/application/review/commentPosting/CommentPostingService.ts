import type { MrDiscussionGateway } from '../../shared/port/gateway/index.js';
import { CommentFormatter, SuggestCommentFormatter } from '../../shared/comment/index.js';
import { ReviewResult } from '../../../domain/review/reviewResult/index.js';
import type { CommentPostingCommand } from './CommentPostingCommand.js';

/**
 * コメント投稿専用サービス
 * レビュー結果をMarkdownコメントにフォーマットし、GitLab MRに投稿する
 * また、変更提案（suggest）の投稿・旧suggestの解決も行う
 */
export class CommentPostingService {
  constructor(private readonly mrDiscussionGateway: MrDiscussionGateway) {}

  /**
   * レビュー結果をフォーマットしてMRにコメント投稿する
   * 全結果が非表示評定に該当する場合はノート、それ以外はディスカッションとして投稿する
   * その後、旧suggestディスカッションの解決と新suggestディスカッションの投稿を行う
   */
  async execute(command: CommentPostingCommand): Promise<void> {
    // コメントのMarkdownテキストを生成
    const body = CommentFormatter.formatComment(
      command.results,
      command.ratings,
      command.commitHash,
      command.commitMessage,
      command.hiddenRatingLabels,
      command.qualityGateResult,
    );

    // 全結果が非表示評定に該当する場合はノート、それ以外はディスカッションとして投稿
    if (ReviewResult.allAreHidden(command.results, command.hiddenRatingLabels)) {
      await this.mrDiscussionGateway.postNote(command.projectId, command.mrIid, body);
    } else {
      await this.mrDiscussionGateway.postReviewDiscussion(command.projectId, command.mrIid, body);
    }

    // 旧suggestディスカッションを解決
    for (const discussionId of command.suggestDiscussionIdsToResolve) {
      await this.mrDiscussionGateway.resolveDiscussion(
        command.projectId,
        command.mrIid,
        discussionId,
      );
    }

    // 新suggestディスカッションを投稿
    for (const resolved of command.suggestions) {
      const suggestBody = SuggestCommentFormatter.format(resolved);
      await this.mrDiscussionGateway.postSuggestDiscussion(
        command.projectId,
        command.mrIid,
        suggestBody,
        {
          baseSha: command.baseSha,
          headSha: command.headSha,
          startSha: command.startSha,
          oldPath: resolved.oldPath,
          newPath: resolved.newPath,
          newLine: resolved.newLine,
        },
      );
    }
  }
}
