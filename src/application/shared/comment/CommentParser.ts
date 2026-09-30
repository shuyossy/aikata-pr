import { ReviewResult, ERROR_RATING_LABEL } from '../../../domain/review/reviewResult/index.js';
import { CheckItem } from '../../../domain/review/checkItem/index.js';
import {
  Rating,
  OUT_OF_SCOPE_RATING,
  OUT_OF_SCOPE_RATING_LABEL,
} from '../../../domain/review/rating/index.js';
import { REVIEW_MARKER, REVIEW_DATA_PREFIX, REVIEW_DATA_SUFFIX } from './CommentFormatter.js';

/** メタデータに格納されるレビュー結果 */
interface MetadataResult {
  checkItemContent: string;
  ratingLabel: string;
  comment: string;
}

/** メタデータのJSON構造 */
interface ReviewMetadata {
  ratings: { label: string; definition: string }[];
  commitHash: string;
  /**
   * 可視レビュー結果
   * 旧フォーマットのコメントには存在しないため、その場合は表をパースして復元する
   */
  visibleResults?: MetadataResult[];
  hiddenResults?: MetadataResult[];
}

/**
 * パース結果の型
 */
export interface ParsedReviewComment {
  results: ReviewResult[];
  ratings: Rating[];
  commitHash: string;
  hiddenResults: ReviewResult[];
}

/**
 * MRコメントからチェック結果を抽出するパーサー
 * マーカー識別、メタデータ復元、表パースを担当する
 */
export class CommentParser {
  /**
   * コメント本文をパースし、レビュー結果を抽出する
   * マーカーが含まれていない場合はnullを返す
   */
  static parseComment(body: string): ParsedReviewComment | null {
    if (!body.includes(REVIEW_MARKER)) {
      return null;
    }

    const lines = body.split('\n');
    const metadata = CommentParser.extractMetadata(lines);
    const ratings = metadata.ratings.map((r) => new Rating(r.label, r.definition));

    // 可視結果はメタデータから復元する
    // メタデータに含まれない場合は旧フォーマットのコメントなので表をパースする
    const results =
      metadata.visibleResults !== undefined
        ? metadata.visibleResults.map((vr) => CommentParser.toReviewResult(vr, ratings))
        : CommentParser.parseTableRows(lines, ratings);

    // メタデータから非表示結果を復元
    const hiddenResults = (metadata.hiddenResults ?? []).map((hr) =>
      CommentParser.toReviewResult(hr, ratings),
    );

    return {
      results,
      ratings,
      commitHash: metadata.commitHash,
      hiddenResults,
    };
  }

  /**
   * メタデータJSONを抽出してパースする
   */
  private static extractMetadata(lines: string[]): ReviewMetadata {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(REVIEW_DATA_PREFIX) && trimmed.endsWith(REVIEW_DATA_SUFFIX)) {
        const jsonStr = trimmed.slice(
          REVIEW_DATA_PREFIX.length,
          trimmed.length - REVIEW_DATA_SUFFIX.length,
        );
        return JSON.parse(jsonStr) as ReviewMetadata;
      }
    }
    throw new Error('Review metadata not found in comment body');
  }

  /**
   * メタデータのレビュー結果をReviewResultに復元する
   */
  private static toReviewResult(result: MetadataResult, ratings: Rating[]): ReviewResult {
    const checkItem = new CheckItem(result.checkItemContent);
    if (result.ratingLabel === ERROR_RATING_LABEL) {
      return ReviewResult.error(checkItem, result.comment);
    }
    const rating = CommentParser.findRating(result.ratingLabel, ratings);
    return ReviewResult.success(checkItem, rating, result.comment);
  }

  /**
   * Markdownテーブルの各行をパースしてReviewResult配列を生成する
   * 旧フォーマット（メタデータに可視結果を含まない）のコメント向けの後方互換パス
   */
  private static parseTableRows(lines: string[], ratings: Rating[]): ReviewResult[] {
    const results: ReviewResult[] = [];

    const separatorPattern = /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/;

    let headerFound = false;
    let separatorFound = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // テーブル行を分割（エスケープされたパイプを考慮）
      const cells = CommentParser.splitTableRow(trimmed);
      if (!cells || cells.length !== 3) {
        // テーブルのコンテキスト外になったらヘッダ/セパレータのフラグをリセット
        if (headerFound && separatorFound && trimmed !== '' && !trimmed.startsWith('|')) {
          headerFound = false;
          separatorFound = false;
        }
        continue;
      }

      // ヘッダ行の検出（最初のテーブル行）
      if (!headerFound) {
        headerFound = true;
        continue;
      }

      // セパレータ行の検出
      if (!separatorFound && separatorPattern.test(trimmed)) {
        separatorFound = true;
        continue;
      }

      // データ行のパース（エスケープを復元）
      const content = CommentParser.unescapeCell(cells[0]);
      const ratingLabel = CommentParser.unescapeCell(cells[1]);
      const comment = CommentParser.unescapeCell(cells[2]);

      const checkItem = new CheckItem(content);

      if (ratingLabel === ERROR_RATING_LABEL) {
        // エラー行
        results.push(ReviewResult.error(checkItem, comment));
      } else {
        // 正常行: メタデータからRating定義を参照
        const rating = CommentParser.findRating(ratingLabel, ratings);
        results.push(ReviewResult.success(checkItem, rating, comment));
      }
    }

    return results;
  }

  /**
   * エスケープされていないパイプでテーブル行を分割する
   * 注意: 本メソッドはCommentFormatterが生成した行（セル間に空白あり）を前提としている。
   * 完全なGFMパーサーでは `\\|`（リテラルバックスラッシュ + パイプ）の二重エスケープ判定が必要だが、
   * 本システムではescapeCellがバックスラッシュをエスケープしないため、この簡略化で正しく動作する。
   */
  private static splitTableRow(line: string): string[] | null {
    if (!line.startsWith('|') || !line.endsWith('|')) {
      return null;
    }
    // 先頭と末尾のパイプを除去
    const inner = line.slice(1, -1);
    const cells: string[] = [];
    let current = '';
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '|' && (i === 0 || inner[i - 1] !== '\\')) {
        cells.push(current.trim());
        current = '';
      } else {
        current += inner[i];
      }
    }
    cells.push(current.trim());
    return cells;
  }

  /**
   * エスケープされたパイプ文字と改行を復元する
   */
  private static unescapeCell(value: string): string {
    return value.replace(/\\\|/g, '|').replace(/<br>/g, '\n');
  }

  /**
   * ラベルに一致するRatingをメタデータの定義から検索する
   * out-of-scope の予約フォールバックラベルは ratings に未登録でも常に受理する
   * （ユーザが評定リストから '-' を外している状況での再レビュー時クラッシュを防ぐ）
   */
  private static findRating(label: string, ratings: Rating[]): Rating {
    const found = ratings.find((r) => r.label === label);
    if (found) {
      return found;
    }
    if (label === OUT_OF_SCOPE_RATING_LABEL) {
      return OUT_OF_SCOPE_RATING;
    }
    throw new Error(`Rating definition not found for label: ${label}`);
  }
}
