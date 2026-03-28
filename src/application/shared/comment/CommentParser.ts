import { ReviewResult, ERROR_RATING_LABEL } from '../../../domain/reviewResult/index.js';
import { CheckItem } from '../../../domain/checkItem/index.js';
import { Rating } from '../../../domain/rating/index.js';
import { REVIEW_MARKER, REVIEW_DATA_PREFIX, REVIEW_DATA_SUFFIX } from './CommentFormatter.js';

/** メタデータのJSON構造 */
interface ReviewMetadata {
  ratings: { label: string; definition: string }[];
  commitHash: string;
}

/**
 * パース結果の型
 */
export interface ParsedReviewComment {
  results: ReviewResult[];
  ratings: Rating[];
  commitHash: string;
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
    const results = CommentParser.parseTableRows(lines, ratings);

    return {
      results,
      ratings,
      commitHash: metadata.commitHash,
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
   * Markdownテーブルの各行をパースしてReviewResult配列を生成する
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
   * エスケープされたパイプ文字を復元する
   */
  private static unescapeCell(value: string): string {
    return value.replace(/\\\|/g, '|');
  }

  /**
   * ラベルに一致するRatingをメタデータの定義から検索する
   */
  private static findRating(label: string, ratings: Rating[]): Rating {
    const found = ratings.find((r) => r.label === label);
    if (!found) {
      throw new Error(`Rating definition not found for label: ${label}`);
    }
    return found;
  }
}
