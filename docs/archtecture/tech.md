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
チェックの実行からMRのコメント投稿まで実行する。

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
- インフラ層
- プレゼンテーション層
  - CLIインターフェース: `node dist/index.js [options]`
  - 全パラメータはCLIオプションと環境変数の両方で指定可能（優先順位: CLIオプション > 環境変数 > デフォルト値）
  - CLIオプション（環境変数フォールバック付き）
    - `--user-id` / `USER_ID`: 実行ユーザID
    - `--project-id` / `GITLAB_PROJECT_ID`: GitLabプロジェクトID
    - `--mr-iid` / `GITLAB_MR_IID`: MR IID
    - `--checklist` / `CHECKLIST_PATH`: チェックリストファイルパス
    - `--review-settings` / `REVIEW_SETTINGS_PATH`: レビュー設定ファイルパス
    - `--skills` / `SKILLS_PATH`: skillsパス
    - `--gitlab-token` / `GITLAB_TOKEN`: GitLab APIトークン
    - `--ai-model-name` / `AI_MODEL_NAME`: AIモデル名（デフォルト: `openai/o4-mini`）
    - `--log-level` / `LOG_LEVEL`: ログレベル
    - `--verbose-error` / `VERBOSE_ERROR`: エラーログ詳細表示の有無
  - 環境変数のみ（秘密情報・環境固有）
    - `AI_API_KEY`: AI APIキー
    - `AI_API_ENDPOINT_URL`: AI APIエンドポイントURL

# CI/CD設計
このセクションは本プロジェクトで利用するCI/CDパイプラインに関するものなので注意。

CI/CDパイプラインでは以下のジョブを実行する
- テスト
- ビルド・保存
  - バンドルして`dist`に保存する

# エラー設計
- 独自のエラーメッセージは英語表記とする
- チェックロジックはエラーになった場合、その場で異常終了とする
    - アプリケーションサービス呼び出しの際は、try-catchで全てのエラーを補足し、エラーメッセージを表示し（stderr）異常終了とする
        - エラーログの詳細表示が指定されている場合は、場合はスタックトレース等も含めて全てのエラー情報を表示する
        - また、全てのエラーメッセージに時刻とユーザIDを付与する

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
