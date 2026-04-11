import type { MrDiscussionGateway } from '../shared/port/gateway/index.js';
import { CommentFormatter } from '../shared/comment/index.js';
import { ReviewResult } from '../../domain/review/reviewResult/index.js';
import type { CommentPostingCommand } from './CommentPostingCommand.js';

/**
 * コメント投稿専用サービス
 * レビュー結果をMarkdownコメントにフォーマットし、GitLab MRに投稿する
 */
export class CommentPostingService {
  constructor(private readonly mrDiscussionGateway: MrDiscussionGateway) {}

  /**
   * レビュー結果をフォーマットしてMRにコメント投稿する
   * 全結果が非表示評定に該当する場合はノート、それ以外はディスカッションとして投稿する
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
      await this.mrDiscussionGateway.postDiscussion(command.projectId, command.mrIid, body);
    }
  }
}
