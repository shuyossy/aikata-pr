# 全体方針
- 採用アーキテクチャ: クリーンアーキテクチャ
- 関連技術
  - TypeScript
  - Mastra
  - GitLab CI/CD

# 全体設計
提供用CIテンプレートのジョブでチェックロジックを呼び出す（GitLab CI/CDの制約上、テンプレート提供先でチェックロジックが実行されるのでロジックの実態は別の場所からダウンロードする必要がある）。
チェックに関する処理は`src`に集約することで、ジョブのチェック以外のスクリプトは最小限に抑える。

## 提供用CIテンプレート
チェックロジックに必要な環境変数やファイルを用意し、チェックロジックを本プロジェクトの`dist`よりダウンロードし実行する

## チェックロジック
2つのモードで動作する:
- **ローカルモード**: `AI_API_KEY`、`AI_API_ENDPOINT_URL`、`AI_MODEL_NAME`が全て設定されている場合。CLIが全処理をローカルで実行する（開発用・後方互換）
- **APIモード**: 上記3変数のいずれかが未設定の場合。CLIは外部APIサーバー（`AIKATA_API_URL`）にレビュー実行を委譲し、コメント投稿・品質ゲート評価はCLI側で実行する。`AIKATA_API_URL`と`AIKATA_JWT`が必要

一般的なクリーンアーキテクチャに従う。
用語集(`docs/domain`)と整合するよう注意すること。
以下は特筆事項
- Domain層
- Application層
  - サービス
    - 命名規則: ~Service
    - 入力、出力はDTOで管理
      - 入力: ~Command
      - 出力: ~Dto
    - 入力時のオプションはoptions?引数として一括管理
  - 主要サービス
    - ReviewExecutionService: AIレビュー実行（MRコンテキスト取得→Workflow実行→結果返却）。APIサーバー側で使用
    - CommentPostingService: コメント投稿（結果整形→GitLab投稿）。CLI側で使用
- インフラ層
  - Mastra層（`src/mastra`）についてはAIワークフロー実行基盤としてインフラ層の一種とみなす※ポートは`src/application/shared/port/workflow`
- プレゼンテーション層
  - CLIインターフェース: `node dist/index.js [options]`
  - APIサーバーインターフェース: `node dist/server.js`
    - Honoフレームワーク
    - `POST /api/v1/review` — SSEストリーミングレスポンス
    - JWT認証ミドルウェア（GitLab CI/CD `id_tokens`を検証）
  - 全パラメータはCLIオプションと環境変数の両方で指定可能（優先順位: CLIオプション > 環境変数 > デフォルト値）
  - CLIオプション（環境変数フォールバック付き）
    - `--user-id` / `USER_ID`: 実行ユーザID
    - `--project-id` / `GITLAB_PROJECT_ID`: GitLabプロジェクトID
    - `--mr-iid` / `GITLAB_MR_IID`: MR IID
    - `--checklist` / `CHECKLIST_PATH`: チェックリストファイルパス
    - `--checklist-columns` / `CHECKLIST_COLUMNS`: チェックリストCSVの抽出列番号（カンマ区切り、1始まり）
    - `--checklist-no-header` / `CHECKLIST_NO_HEADER`: 抽出列が1列の場合にヘッダを除外するか（デフォルト: `false`）
    - `--review-settings` / `REVIEW_SETTINGS_PATH`: レビュー設定ファイルパス
    - `--skills` / `SKILLS_PATH`: skillsパス
    - `--aikata-pr-gitlab-token` / `AIKATA_PR_GITLAB_TOKEN`: GitLab APIトークン
    - `--ai-model-name` / `AI_MODEL_NAME`: AIモデル名（デフォルト: `openai/o4-mini`）
    - `--log-level` / `AIKATA_LOG_LEVEL`: ログレベル
    - `--comment-language` / `COMMENT_LANGUAGE`: レビューコメントの言語（デフォルト: `Japanese`）
    - `--aikata-api-url` / `AIKATA_API_URL`: APIサーバーURL（設定時はAPIモードで動作）
  - 環境変数のみ（秘密情報・環境固有）
    - `AI_API_KEY`: AI APIキー（ローカルモード時のみ必要、APIモード時はAPIサーバー側で管理）
    - `AI_API_ENDPOINT_URL`: AI APIエンドポイントURL（同上）
    - `AIKATA_JWT`: GitLab CI/CDのid_tokensで自動生成されるJWTトークン（APIモード時に使用）

# CI/CD設計
このセクションは本プロジェクトで利用するCI/CDパイプラインに関するものなので注意。

CI/CDパイプラインでは以下のジョブを実行する
- テスト
- ビルド・保存
  - バンドルして`dist`に保存する

# エラー設計
- 独自のエラーメッセージは英語表記とする
- チェックロジックはエラーになった場合、その場で異常終了とする
    - アプリケーションサービス呼び出しの際は、try-catchで全てのエラーを補足し、スタックトレース等を含む詳細なエラー情報を表示し（stderr）異常終了とする
        - 全てのエラーメッセージに時刻とユーザIDを付与する

# ログ設計
Pinoを利用。
時刻とユーザIDを常に表示する。

## エラーログ出力方法
エラーオブジェクトをログ出力する際は、`pino-std-serializers`の`errWithCause`シリアライザーを利用

# AI処理について
本プロジェクトでAIに関する処理を実行する際は全てMastraを利用する
関連キーワード
- agent
- workflow
- tool
- mcp
- ...
