import { encode } from 'gpt-tokenizer';

/**
 * デフォルトの最大出力トークン数
 * mastra_workspace_read_fileのデフォルト(2000)よりやや多め。
 * diffやログの省略部分は調査目的で取得されるため、適度な量を返す。
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

/**
 * 出力制限オプション
 */
export interface OutputLimitOptions {
  /** 最大出力トークン数（デフォルト: 3000） */
  maxOutputTokens?: number;
  /** 行番号を付与するか（デフォルト: true） */
  showLineNumbers?: boolean;
  /** トークンカウント関数（テスト用注入ポイント、デフォルト: gpt-tokenizer） */
  countTokens?: (text: string) => number;
}

/**
 * 出力制限結果
 */
export interface OutputLimitResult {
  /** 処理後テキスト（行番号付き、必要に応じて切り詰め済み） */
  text: string;
  /** 切り詰めが発生したか */
  truncated: boolean;
  /** 元のコンテンツの総行数 */
  totalLines: number;
  /** 実際に表示された行数 */
  shownLines: number;
  /** トークン情報（truncated=trueの場合のみ） */
  tokenInfo?: { shown: number; total: number };
}

/**
 * デフォルトのトークンカウント関数
 * gpt-tokenizer (cl100k_base) を使用
 */
function defaultCountTokens(text: string): number {
  return encode(text).length;
}

/**
 * 行番号を付与する
 * 総行数の桁数に合わせて右揃えする（例: "  1| content"）
 */
function addLineNumbers(lines: string[], totalLineCount: number): string[] {
  const width = String(totalLineCount).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`);
}

/**
 * テキスト出力にトークン制限を適用する
 *
 * mastra_workspace_read_fileのエッセンスを取り込んだ共通ユーティリティ。
 * - 行番号を付与してAgentがページネーション座標を把握できるようにする
 * - トークン上限を超える場合は末尾から切り詰め（先頭を保持）
 * - 切り詰め時はナビゲーションヒントを付加
 *
 * @param content 制限対象のテキスト
 * @param options 制限オプション
 */
export function applyOutputLimit(content: string, options?: OutputLimitOptions): OutputLimitResult {
  const maxTokens = options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const showLineNumbers = options?.showLineNumbers ?? true;
  const countTokens = options?.countTokens ?? defaultCountTokens;

  // 空文字列の処理
  if (content === '') {
    return { text: '', truncated: false, totalLines: 0, shownLines: 0 };
  }

  const lines = content.split('\n');
  const totalLines = lines.length;

  // 行番号付与
  const numberedLines = showLineNumbers ? addLineNumbers(lines, totalLines) : [...lines];
  const fullText = numberedLines.join('\n');
  const totalTokens = countTokens(fullText);

  // 上限以下ならそのまま返却
  if (totalTokens <= maxTokens) {
    return {
      text: fullText,
      truncated: false,
      totalLines,
      shownLines: totalLines,
    };
  }

  // 切り詰めが必要: 行境界を守りつつ、先頭から収まる最大行数を求める
  // 切り詰め通知のトークン予算を確保（通知文は約40-50トークン、余裕をもって60確保）
  const truncationNoticeReserve = 60;
  const contentBudget = Math.max(maxTokens - truncationNoticeReserve, 1);

  // 二分探索で収まる最大行数を求める
  let lo = 1; // 最低1行は表示
  let hi = totalLines;
  let bestFit = 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidateText = numberedLines.slice(0, mid).join('\n');
    const candidateTokens = countTokens(candidateText);

    if (candidateTokens <= contentBudget) {
      bestFit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const shownLines = bestFit;
  const shownText = numberedLines.slice(0, shownLines).join('\n');
  const shownTokens = countTokens(shownText);

  const truncationNotice =
    `\n[output truncated: showing first ~${shownTokens} of ~${totalTokens} tokens ` +
    `(${shownLines} of ${totalLines} lines). ` +
    `Use startLine/maxLines to navigate, or add keywords to narrow results.]`;

  return {
    text: shownText + truncationNotice,
    truncated: true,
    totalLines,
    shownLines,
    tokenInfo: { shown: shownTokens, total: totalTokens },
  };
}
