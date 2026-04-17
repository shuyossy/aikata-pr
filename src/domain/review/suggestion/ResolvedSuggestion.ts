import { Suggestion } from './Suggestion.js';

/**
 * 解決済み変更提案の値オブジェクト
 * SuggestionにGitLab API投稿に必要な行番号情報を付与したもの
 */
export interface ResolvedSuggestionParams {
  /** 元のSuggestion */
  suggestion: Suggestion;
  /** アンカー行番号（新しい側の行番号） */
  newLine: number;
  /** suggestion:-X（アンカー行より上の行数） */
  linesAbove: number;
  /** suggestion:+Y（アンカー行より下の行数） */
  linesBelow: number;
  /** position[old_path] */
  oldPath: string;
  /** position[new_path] */
  newPath: string;
}

/** GitLabのsuggestion範囲の上限 */
const GITLAB_MAX_SUGGESTION_RANGE = 201;

export class ResolvedSuggestion {
  readonly suggestion: Suggestion;
  readonly newLine: number;
  readonly linesAbove: number;
  readonly linesBelow: number;
  readonly oldPath: string;
  readonly newPath: string;

  constructor(params: ResolvedSuggestionParams) {
    if (params.newLine < 1) {
      throw new Error('newLine must be >= 1');
    }
    if (params.linesAbove < 0) {
      throw new Error('linesAbove must be >= 0');
    }
    if (params.linesBelow < 0) {
      throw new Error('linesBelow must be >= 0');
    }
    if (params.linesAbove + params.linesBelow + 1 > GITLAB_MAX_SUGGESTION_RANGE) {
      throw new Error(
        `Suggestion range (linesAbove + linesBelow + 1) must not exceed ${GITLAB_MAX_SUGGESTION_RANGE}`,
      );
    }
    if (params.oldPath.trim() === '') {
      throw new Error('oldPath must not be empty');
    }
    if (params.newPath.trim() === '') {
      throw new Error('newPath must not be empty');
    }

    this.suggestion = params.suggestion;
    this.newLine = params.newLine;
    this.linesAbove = params.linesAbove;
    this.linesBelow = params.linesBelow;
    this.oldPath = params.oldPath;
    this.newPath = params.newPath;
  }
}
