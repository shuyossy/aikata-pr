import { ReviewResult } from '../../../domain/reviewResult/index.js';
import { CheckItem } from '../../../domain/checkItem/index.js';
import { Rating } from '../../../domain/rating/index.js';
import { REVIEW_MARKER, REVIEW_DATA_PREFIX, REVIEW_DATA_SUFFIX } from './CommentFormatter.js';

/** エラー評定ラベル */
const ERROR_LABEL = 'エラー';

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
    // マーカーの存在チェック
    if (!body.includes(REVIEW_MARKER)) {
      return null;
    }

    // メタデータの抽出
    const metadata = CommentParser.extractMetadata(body);

    // Rating定義の復元
    const ratings = metadata.ratings.map((r) => new Rating(r.label, r.definition));

    // テーブル行のパース
    const results = CommentParser.parseTableRows(body, ratings);

    return {
      results,
      ratings,
      commitHash: metadata.commitHash,
    };
  }

  /**
   * メタデータJSONを抽出してパースする
   */
  private static extractMetadata(body: string): ReviewMetadata {
    const lines = body.split('\n');
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
  private static parseTableRows(body: string, ratings: Rating[]): ReviewResult[] {
    const lines = body.split('\n');
    const results: ReviewResult[] = [];

    // テーブル行パターン: | content | rating | comment |
    // ヘッダ行とセパレータ行をスキップする
    const tableRowPattern = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/;
    const separatorPattern = /^\|\s*-+\s*\|\s*-+\s*\|\s*-+\s*\|$/;

    let headerFound = false;
    let separatorFound = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // テーブル行にマッチしない場合はスキップ
      const match = trimmed.match(tableRowPattern);
      if (!match) {
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

      // データ行のパース
      const [, content, ratingLabel, comment] = match;

      const checkItem = new CheckItem(content);

      if (ratingLabel === ERROR_LABEL) {
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
