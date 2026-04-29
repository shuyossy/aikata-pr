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
- PBI名: SSE接続断に対する耐性強化
- ステータス: done
- 背景
  - APIモードで実行する際に、セルフホストGitLabのネットワーク環境制約で以下のようなSSEエラーが発生することがある。リトライすると成功することもあるのでコードの不備ではなくネットワーク環境による制約であると考えている
  ```
  ERROR [2026-04-28 06:02:31.459 +0000] (aikata-pr): Review failed
    userId: "PIT04447"
    err: {
      "type": "Error",
      "message": "SSE stream ended without result event",
      "stack":
          Error: SSE stream ended without result event
              at ReviewApiClient.parseSSEStream (file:///opt/aikata-pr/dist/index.js:2903:11)
              at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
              at async Object.run (file:///opt/aikata-pr/dist/index.js:7440:25)
              at async dispatch (file:///opt/aikata-pr/dist/index.js:9327:3)
    }
  ```
- 受け入れ基準
  - エラー内容を解析し、必要な対策を実施できていること
  - SSEのコネクション断が発生しても、APIサーバ側で処理が成功した場合は、少なくとも最終的な処理結果は何とかクライアント側に連携できるような仕組みが構築されていること
- 注意事項
  - SSEで処理途中の進捗状況をクライアント側に連携することは最悪、犠牲にして良いが、最終的な処理結果は何とかクライアント側に連携したい。この場合、SSEにこだわりはない。実現方法を多角的に徹底的に調査すること
  - APIサーバ側の処理は最長20分~30分程度と考えておけばよい
- 指摘事項（in progressの場合のみ）
