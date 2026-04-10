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
- PBI名: mastraの仕様に関する認識不足があるかもしれない件
- ステータス: done
- 背景
  - mastraは比較的新しいフレームワークなので、使用の認識不足による不備がおこりやすい
  - たとえば、memoryのrecallではデフォルトでページネーションするのでは？
    - 上記は現状想定できていない（修正が必要）し、他にも使用の認識不足がありそう
- 受け入れ基準
  - 背景をよく理解した上で、不備ないか全量チェックできていること
  - 問題ある箇所は不具合修正できていること
- 注意事項
- 監査結果
  - 対象バージョン: `@mastra/core@^1.16.0`, `@mastra/memory@^1.10.0`, `@mastra/libsql@^1.7.2`
  - 確定バグ（修正済み）:
    - `memory.recall()` はデフォルトで `perPage=40` のページネーションを行う（`node_modules/@mastra/core/dist/storage/types.d.ts:67-71`、`node_modules/@mastra/libsql/dist/index.js:5539` で確認）
    - 影響箇所:
      - `src/mastra/workflows/steps/contextLengthRecovery.ts` — コンテキスト長エラー回復時の履歴取得。先頭40件しか取れず、要約元の大半を失っていた
      - `src/mastra/workflows/steps/reviewExecution.ts` — 連続レート制限時の重複継続プロンプト検知。40件超の履歴で重複を見逃し、メモリ肥大化を招いていた
    - 修正内容: いずれも `perPage: false` を明示（contextLengthRecovery 側は `orderBy: { field: 'createdAt', direction: 'ASC' }` も追加）
    - リグレッション防止: `AGENTS.md` に注意書きを追加
  - 検証済み・問題なし（embedded docs参照）:
    - `recall()` 関数名は現行API（`query`ではない）
    - `agent.generate(prompt, { memory: { thread, resource } })` は現行API
    - `maxSteps: 50`、`prepareStep` hook はいずれも現行API
    - `new Memory()` は Mastraインスタンスの storage を継承する（DefaultStorage にはフォールバックしない）
    - `semanticRecall` の実コードデフォルトは `false`（vector未設定でもエラーにならない）
    - `workingMemory` はデフォルト `enabled: false` で本プロジェクトでは未使用
    - モジュールレベル `Memory` インスタンスは thread/resource ID がリクエスト毎に一意のため問題なし
    - `lastMessages: 1000` は現行API（デフォルトは10）
    - `deleteThread`, `deleteMessages`, `workflow.createRun().start()` いずれも現行API
  - 今後の課題（別PBI候補）:
    - LibSQL（ファイルベース）への concurrency=5 同時アクセスは WALロック競合リスクがあるが、MR1件分のレビューは同一プロセス内で完結するため現時点で問題化していない。将来の分散デプロイ時にTurso等への移行を検討

