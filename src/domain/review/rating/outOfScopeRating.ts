import { Rating } from './Rating.js';

/**
 * out-of-scope（評価対象外）用の予約評定ラベル
 *
 * ユーザ設定の評定リスト（ReviewSettings.ratings）に含まれていなくても、
 * AIが「diffの内容がチェック項目に対して評価対象外」と判断したケースで
 * フォールバックとして常に格納可能とする。
 *
 * ユーザが評定リストに同じラベル '-' を独自定義で含めている場合は、
 * そちらが優先される（storeReviewResult / CommentParser の通常検索パスでヒットするため）。
 */
export const OUT_OF_SCOPE_RATING_LABEL = '-';

export const OUT_OF_SCOPE_RATING_DEFINITION =
  'チェック項目の要件がdiffの変更内容に該当しない、または評価不能';

/** 予約フォールバック評定の固定インスタンス */
export const OUT_OF_SCOPE_RATING = new Rating(
  OUT_OF_SCOPE_RATING_LABEL,
  OUT_OF_SCOPE_RATING_DEFINITION,
);
