import { ReviewResult, ERROR_RATING_LABEL } from '../../../domain/reviewResult/index.js';
import { Rating } from '../../../domain/rating/index.js';

/** aikataレビューコメント識別用マーカー */
export const REVIEW_MARKER = '<!-- aikata-review -->';

/** メタデータマーカーのプレフィックス */
export const REVIEW_DATA_PREFIX = '<!-- aikata-review-data: ';

/** メタデータマーカーのサフィックス */
export const REVIEW_DATA_SUFFIX = ' -->';

/** 折りたたみ表示にする閾値（この値を超えたら折りたたみ） */
export const FOLD_THRESHOLD = 15;

/**
 * MRコメント投稿用のMarkdown整形ロジック
 * マーカー埋め込み、表生成、折りたたみを担当する
 */
export class CommentFormatter {
  /**
   * レビュー結果からMRコメント用のMarkdownテキストを生成する
   */
  static formatComment(results: ReviewResult[], ratings: Rating[], commitHash: string): string {
    const lines: string[] = [];

    // 識別用マーカー
    lines.push(REVIEW_MARKER);

    // メタデータマーカー（評定基準とコミットハッシュを埋め込む）
    const metadata = {
      ratings: ratings.map((r) => ({ label: r.label, definition: r.definition })),
      commitHash,
    };
    lines.push(`${REVIEW_DATA_PREFIX}${JSON.stringify(metadata)}${REVIEW_DATA_SUFFIX}`);

    // Markdownテーブルを生成
    const table = CommentFormatter.buildTable(results);

    // 折りたたみ判定
    if (results.length > FOLD_THRESHOLD) {
      lines.push('');
      lines.push('<details>');
      lines.push(`<summary>レビュー結果（${results.length}件）</summary>`);
      lines.push('');
      lines.push(table);
      lines.push('');
      lines.push('</details>');
    } else {
      lines.push('');
      lines.push(table);
    }

    return lines.join('\n');
  }

  /**
   * レビュー結果からMarkdownテーブルを生成する
   */
  private static buildTable(results: ReviewResult[]): string {
    const header = '| チェック項目 | 評定 | コメント |';
    const separator = '| --- | --- | --- |';
    const rows = results.map((result) => {
      const ratingLabel = result.isError ? ERROR_RATING_LABEL : result.rating.label;
      return `| ${CommentFormatter.escapeCell(result.checkItem.content)} | ${ratingLabel} | ${CommentFormatter.escapeCell(result.comment)} |`;
    });

    return [header, separator, ...rows].join('\n');
  }

  /**
   * テーブルセル内のパイプ文字をGFM準拠でエスケープする
   */
  private static escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|');
  }
}
