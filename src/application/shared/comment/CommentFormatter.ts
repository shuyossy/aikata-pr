import { ReviewResult, ERROR_RATING_LABEL } from '../../../domain/reviewResult/index.js';
import { Rating } from '../../../domain/rating/index.js';
import type { QualityGateResult } from '../../../domain/qualityGate/index.js';

/** aikataレビューコメント識別用マーカー */
export const REVIEW_MARKER = '<!-- aikata-review -->';

/** メタデータマーカーのプレフィックス */
export const REVIEW_DATA_PREFIX = '<!-- aikata-review-data: ';

/** メタデータマーカーのサフィックス */
export const REVIEW_DATA_SUFFIX = ' -->';

/** 折りたたみ表示にする閾値（この値を超えたら折りたたみ） */
export const FOLD_THRESHOLD = 2;

/**
 * MRコメント投稿用のMarkdown整形ロジック
 * マーカー埋め込み、表生成、折りたたみを担当する
 */
export class CommentFormatter {
  /**
   * レビュー結果からMRコメント用のMarkdownテキストを生成する
   */
  static formatComment(
    results: ReviewResult[],
    ratings: Rating[],
    commitHash: string,
    commitMessage: string,
    hiddenRatingLabels: string[],
    qualityGateResult: QualityGateResult,
  ): string {
    // 表示/非表示に分割（エラー結果は常に表示）
    const visibleResults = results.filter(
      (r) => r.isError || !hiddenRatingLabels.includes(r.rating.label),
    );
    const hiddenResults = results.filter(
      (r) => !r.isError && hiddenRatingLabels.includes(r.rating.label),
    );

    const lines: string[] = [];

    // 識別用マーカー
    lines.push(REVIEW_MARKER);

    // メタデータマーカー（評定基準、コミットハッシュ、非表示結果を埋め込む）
    const metadata: Record<string, unknown> = {
      ratings: ratings.map((r) => ({ label: r.label, definition: r.definition })),
      commitHash,
    };
    if (hiddenResults.length > 0) {
      metadata.hiddenResults = hiddenResults.map((r) => ({
        checkItemContent: r.checkItem.content,
        ratingLabel: r.rating.label,
        comment: r.comment,
      }));
    }
    lines.push(`${REVIEW_DATA_PREFIX}${JSON.stringify(metadata)}${REVIEW_DATA_SUFFIX}`);

    // ヘッダー
    lines.push('');
    lines.push('## AIKATA-PR レビュー結果');
    lines.push(`レビュー時最新コミット: ${commitMessage}`);

    // 品質ゲート警告（テーブルの上に表示）
    if (!qualityGateResult.passed) {
      lines.push('');
      lines.push('> **⚠ Quality Gate Failed**');
      for (const v of qualityGateResult.violations) {
        lines.push(`> - Rating "${v.ratingLabel}" : ${v.actualCount} (threshold: ${v.threshold})`);
      }
    }

    if (ReviewResult.allAreHidden(results, hiddenRatingLabels)) {
      // 全ての結果が非表示評定に該当する場合
      lines.push('');
      lines.push('全てのチェック項目が非表示の評定に該当しました。');
    } else {
      // Markdownテーブルを生成
      const table = CommentFormatter.buildTable(visibleResults);

      // 折りたたみ判定
      if (visibleResults.length > FOLD_THRESHOLD) {
        lines.push('');
        lines.push('<details>');
        lines.push(`<summary>レビュー結果（${visibleResults.length}件）</summary>`);
        lines.push('');
        lines.push(table);
        lines.push('');
        lines.push('</details>');
      } else {
        lines.push('');
        lines.push(table);
      }
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
   * テーブルセル内のパイプ文字と改行をGFM準拠でエスケープする
   */
  private static escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  }
}
