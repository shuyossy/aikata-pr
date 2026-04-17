/**
 * 行番号解決の結果
 */
export interface LineResolveResult {
  success: boolean;
  newLine?: number;
  linesAbove?: number;
  linesBelow?: number;
  oldPath?: string;
  newPath?: string;
  errorMessage?: string;
}

/**
 * diffを解析してコード断片から行番号を解決するポート
 * storeSuggestツールからリアルタイムに呼び出される
 */
export interface SuggestionLineResolver {
  resolve(filePath: string, originalCode: string, mrDiff: string): LineResolveResult;
}
