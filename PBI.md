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

# ID: 0
- PBI名: 事前準備
- ステータス: done
- 背景
  - ID:1以降にスムーズに開発作業に入れる様に、環境を準備しておく必要がある
- 受け入れ基準
  - ロガーが整備できていること
  - `.gitlab-ci.yml`が整備できていること
  - formatter/ESLintが整備されていること
  - `.ci-template`が整備されていること
  - vitestが整備されていること
  - チェックロジックがバンドルでき、CLI上で呼び出せること
  - 整備の結果として主要コマンドが`AGENTS.md`にまとめられていること
- 注意事項
- 指摘事項（in progressの場合のみ）

# ID: 1
- PBI名: システム処理フローの作成
- ステータス: done
- 背景
  - 処理フロー概念設計にて設計した処理フローを組み立てる
- 受け入れ基準
  - 処理フロー概念設計に併せて、処理が実行できる様になっている
- 注意事項
  - mastra workflowの作成方針（ベストプラクティスに基づいて作成すること）
    - チェックリスト分割step
    - foreach(レビュー実行step)
  - AgentのモデルはユーザIDに基づいて動的に作成（RequestContext）すること（以下、実装イメージ）
  ```
  import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
  ...
  return createOpenAICompatible({
    name: ${ユーザID},
    apiKey,
    baseURL,
  }).chatModel('openai/o4-mini');
  ```
  - チェックリスト分割step作成時の注意点
    - 同時レビュー項目数が2以上かつ総チェック項目数より少ない場合はAIによる分割を実行
    - Agentの処理が失敗した場合は機械的な分割を実行
    - Agentの処理結果が成功した場合もチェックリストが過不足なく分割できているかチェックし、最終的に同時レビュー項目数を満たせる様に機械的に分割（総レビュー項目数が同時レビュー項目数の倍数にならなかった場合は、最後のグループは同時レビュー項目数以下になるのはもちろん許容する）
- 指摘事項（in progressの場合のみ）
