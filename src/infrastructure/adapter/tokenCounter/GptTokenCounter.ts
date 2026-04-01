import { encode } from 'gpt-tokenizer';
import type { TokenCounter } from '../../../application/shared/port/tokenCounter/index.js';

/**
 * gpt-tokenizerを利用したトークンカウンター実装
 * GPT系モデルのtiktoken(cl100k_base)ベースのトークン数を返す
 */
export class GptTokenCounter implements TokenCounter {
  countTokens(text: string): number {
    return encode(text).length;
  }
}
