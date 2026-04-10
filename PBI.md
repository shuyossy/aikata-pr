雛形
```
# ID:
- PBI名:
- ステータス: [to do/in progress/done]
- ユーザストーリー/背景
- 受け入れ基準
- 注意事項
- 指摘事項（in progressの場合のみ）
```

# ID: 1
- PBI名: レートリミット制限に関する挙動変更
- ステータス: done
- 背景
  - 現状は連続でレートリミット制限になった場合でも、同じメッセージを連続してAIに伝えている
  - そのメッセージについてもチェック未済のチェック項目を全て提示しているためコンテキストの逼迫につながりうる
- 受け入れ基準
  - 連続でレートリミット制限になった場合（判定方法: 直前に保存されているメッセージが'user'かつ、`buildRateLimitContinuationPrompt`で構築したプロンプト）、連続して`buildRateLimitContinuationPrompt`で構築したプロンプトがAIに送信されない
  - `buildRateLimitContinuationPrompt`は簡潔に、チェック項目を含めない
- 注意事項
- 指摘事項（in progressの場合のみ）

