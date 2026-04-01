/**
 * トークン数カウントのポートインターフェース
 * インフラ層で具体的なトークナイザー実装を差し替え可能にする
 */
export interface TokenCounter {
  countTokens(text: string): number;
}
