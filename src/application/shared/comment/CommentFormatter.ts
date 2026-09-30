import { ReviewResult, ERROR_RATING_LABEL } from '../../../domain/review/reviewResult/index.js';
import { Rating } from '../../../domain/review/rating/index.js';
import type { QualityGateResult } from '../../../domain/review/qualityGate/index.js';
import type { ReviewCommentLayout } from '../../../domain/review/reviewSettings/index.js';
import {
  formatCheckItemForDisplay,
  formatCheckItemForHeading,
} from './formatCheckItemForDisplay.js';

/** aikataレビューコメント識別用マーカー */
export const REVIEW_MARKER = '<!-- aikata-review -->';

/** メタデータマーカーのプレフィックス */
export const REVIEW_DATA_PREFIX = '<!-- aikata-review-data: ';

/** メタデータマーカーのサフィックス */
export const REVIEW_DATA_SUFFIX = ' -->';

/** 折りたたみ表示にする閾値（この値を超えたら折りたたみ） */
export const FOLD_THRESHOLD = 2;

/**
 * CommentFormatter.formatCommentの入力
 */
export interface FormatCommentInput {
  results: ReviewResult[];
  ratings: Rating[];
  commitHash: string;
  commitMessage: string;
  hiddenRatingLabels: string[];
  qualityGateResult: QualityGateResult;
  /** MRコメントの見出しタイトル */
  mrCommentTitle: string;
  /** レビュー結果コメントの出力レイアウト */
  layout: ReviewCommentLayout;
  /**
   * AI用content -> 表示用content のマップ
   * 未登録のcontentはAI用contentをそのまま表示に用いる
   */
  checkItemDisplayContents: ReadonlyMap<string, string>;
}

/**
 * MRコメント投稿用のMarkdown整形ロジック
 * マーカー埋め込み、表生成、折りたたみを担当する
 */
export class CommentFormatter {
  /**
   * レビュー結果からMRコメント用のMarkdownテキストを生成する
   */
  static formatComment(input: FormatCommentInput): string {
    const { results, hiddenRatingLabels } = input;

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

    // メタデータマーカー（評定基準、コミットハッシュ、レビュー結果を埋め込む）
    // 表示部分は表示専用であり、再レビュー時の結果復元はこのメタデータから行う
    const metadata: Record<string, unknown> = {
      ratings: input.ratings.map((r) => ({ label: r.label, definition: r.definition })),
      commitHash: input.commitHash,
      visibleResults: visibleResults.map((r) => CommentFormatter.toMetadataResult(r)),
    };
    if (hiddenResults.length > 0) {
      metadata.hiddenResults = hiddenResults.map((r) => CommentFormatter.toMetadataResult(r));
    }
    lines.push(`${REVIEW_DATA_PREFIX}${JSON.stringify(metadata)}${REVIEW_DATA_SUFFIX}`);

    // ヘッダー
    lines.push('');
    lines.push(`## ${input.mrCommentTitle}`);
    lines.push(`レビュー時最新コミット: ${input.commitMessage}`);

    // 品質ゲート警告（テーブルの上に表示）
    if (!input.qualityGateResult.passed) {
      lines.push('');
      lines.push('> **⚠ Quality Gate Failed**');
      for (const v of input.qualityGateResult.violations) {
        lines.push(`> - Rating "${v.ratingLabel}" : ${v.actualCount} (threshold: ${v.threshold})`);
      }
    }

    if (ReviewResult.allAreHidden(results, hiddenRatingLabels)) {
      // 全ての結果が非表示評定に該当する場合
      lines.push('');
      lines.push('全てのチェック項目が非表示の評定に該当しました。');
    } else if (input.layout === 'sections') {
      lines.push(...CommentFormatter.buildSectionsLayout(visibleResults, input));
    } else {
      lines.push(...CommentFormatter.buildTableLayout(visibleResults, input));
    }

    return lines.join('\n');
  }

  /**
   * tableレイアウト（チェック項目・評定・コメントの3列テーブル）を生成する
   */
  private static buildTableLayout(
    visibleResults: ReviewResult[],
    input: FormatCommentInput,
  ): string[] {
    const table = CommentFormatter.buildTable(visibleResults, input, true);
    return CommentFormatter.withFold(table.split('\n'), visibleResults.length, 'レビュー結果');
  }

  /**
   * sectionsレイアウト（2列サマリテーブル + テーブル外の詳細）を生成する
   * サマリテーブルは常に表示し、詳細部分のみ折りたたみ対象とする
   */
  private static buildSectionsLayout(
    visibleResults: ReviewResult[],
    input: FormatCommentInput,
  ): string[] {
    const summary = CommentFormatter.buildTable(visibleResults, input, false);

    const details: string[] = [];
    for (const result of visibleResults) {
      const displayContent = CommentFormatter.resolveDisplayContent(result, input);
      details.push(`### ${formatCheckItemForHeading(displayContent)}`);
      details.push(`**評定**: ${CommentFormatter.resolveRatingLabel(result)}`);
      details.push('');
      // コメント本文はエスケープせず生Markdownとして出力する
      // （ネストしたテーブル・見出し・箇条書きを利用可能にするため）
      details.push(result.comment);
      details.push('');
    }
    // 末尾の余分な空行を除去
    if (details[details.length - 1] === '') {
      details.pop();
    }

    return [
      '',
      summary,
      ...CommentFormatter.withFold(details, visibleResults.length, 'レビュー詳細'),
    ];
  }

  /**
   * 件数が閾値を超える場合に折りたたみ（details/summary）で包む
   */
  private static withFold(body: string[], count: number, summaryLabel: string): string[] {
    if (count > FOLD_THRESHOLD) {
      return [
        '',
        '<details>',
        `<summary>${summaryLabel}（${count}件）</summary>`,
        '',
        ...body,
        '',
        '</details>',
      ];
    }
    return ['', ...body];
  }

  /**
   * レビュー結果からMarkdownテーブルを生成する
   * includeCommentがtrueの場合はコメント列を含む3列、falseの場合は2列のサマリになる
   */
  private static buildTable(
    results: ReviewResult[],
    input: FormatCommentInput,
    includeComment: boolean,
  ): string {
    const header = includeComment
      ? '| チェック項目 | 評定 | コメント |'
      : '| チェック項目 | 評定 |';
    const separator = includeComment ? '| --- | --- | --- |' : '| --- | --- |';
    const rows = results.map((result) => {
      const ratingLabel = CommentFormatter.resolveRatingLabel(result);
      const displayContent = formatCheckItemForDisplay(
        CommentFormatter.resolveDisplayContent(result, input),
      );
      const cells = [CommentFormatter.escapeCell(displayContent), ratingLabel];
      if (includeComment) {
        cells.push(CommentFormatter.escapeCell(result.comment));
      }
      return `| ${cells.join(' | ')} |`;
    });

    return [header, separator, ...rows].join('\n');
  }

  /**
   * レビュー結果の表示用チェック項目テキストを解決する
   * 表示用contentが未登録の場合はAI用contentをそのまま用いる
   */
  private static resolveDisplayContent(result: ReviewResult, input: FormatCommentInput): string {
    return input.checkItemDisplayContents.get(result.checkItem.content) ?? result.checkItem.content;
  }

  /**
   * レビュー結果の表示用評定ラベルを解決する
   */
  private static resolveRatingLabel(result: ReviewResult): string {
    return result.isError ? ERROR_RATING_LABEL : result.rating.label;
  }

  /**
   * レビュー結果をメタデータJSON用の構造に変換する
   * checkItemContentは突合キーであるため、表示用ではなくAI用の生contentを格納する
   */
  private static toMetadataResult(result: ReviewResult): {
    checkItemContent: string;
    ratingLabel: string;
    comment: string;
  } {
    return {
      checkItemContent: result.checkItem.content,
      ratingLabel: CommentFormatter.resolveRatingLabel(result),
      comment: result.comment,
    };
  }

  /**
   * テーブルセル内のパイプ文字と改行をGFM準拠でエスケープする
   */
  private static escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  }
}
