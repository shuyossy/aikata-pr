import { z } from 'zod';
import { ReviewSettings } from '../../../domain/reviewSettings/index.js';
import { Rating } from '../../../domain/rating/index.js';
import { QualityGate } from '../../../domain/qualityGate/index.js';

/**
 * レビュー設定JSONのバリデーションスキーマ
 */
const reviewSettingsSchema = z.object({
  additionalInstructions: z.string().optional(),
  concurrentReviewCount: z.number().int().optional(),
  commentFormat: z.string().optional(),
  ratings: z
    .array(
      z.object({
        label: z.string().min(1),
        definition: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
  hiddenRatingLabels: z.array(z.string().min(1)).optional(),
  qualityGate: z
    .object({
      failureCriteria: z.array(
        z.object({
          ratingLabel: z.string().min(1),
          threshold: z.number().int().min(1),
        }),
      ),
    })
    .optional(),
});

/**
 * レビュー設定JSONパーサー
 * JSON文字列をレビュー設定ドメインオブジェクトに変換する
 */
export class ReviewSettingsParser {
  /**
   * JSON文字列からReviewSettingsを生成する
   * 指定されていないフィールドにはデフォルト値が適用される
   */
  static parse(json: string): ReviewSettings {
    // JSONパース
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`Invalid JSON: ${json}`);
    }

    // Zodバリデーション
    const result = reviewSettingsSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid review settings: ${result.error.message}`);
    }

    const data = result.data;
    const defaults = ReviewSettings.default();

    // 未設定または1未満の場合はnull（分割しない）に変換
    const rawCount = data.concurrentReviewCount;
    const concurrentReviewCount = rawCount === undefined || rawCount < 1 ? null : rawCount;

    // 品質ゲートの構築
    const qualityGate = data.qualityGate
      ? new QualityGate(data.qualityGate.failureCriteria)
      : QualityGate.none();

    return new ReviewSettings({
      additionalInstructions: data.additionalInstructions ?? defaults.additionalInstructions,
      concurrentReviewCount,
      commentFormat: data.commentFormat ?? defaults.commentFormat,
      ratings: data.ratings
        ? data.ratings.map((r) => new Rating(r.label, r.definition))
        : defaults.ratings,
      hiddenRatingLabels: data.hiddenRatingLabels ?? [],
      qualityGate,
    });
  }
}
