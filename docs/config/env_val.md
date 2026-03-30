# 環境変数設計

本アプリは環境変数で様々な挙動の制御が可能

| カテゴリ | 変数名 | 必須 | 既定値 | 主な制御内容 | CLIオプション | 参照箇所 |
| --- | --- | --- | --- | --- | --- | --- |
| AI | AI_API_KEY | Yes | - | AI APIキー（秘密情報） | なし（環境変数のみ） | - |
| AI | AI_API_ENDPOINT_URL | Yes | - | AI APIエンドポイントURL | なし（環境変数のみ） | - |
| AI | AI_MODEL_NAME | Yes | - | AIモデル名 | --ai-model-name | - |
| AI | OPENAI_REASONING_EFFORT | No | - | OpenAI reasoningモデルのreasoning effort（low/medium/high）。設定時はtemperature=1も自動適用 | なし（環境変数のみ） | - |
| GitLab | GITLAB_API_URL | No | CI_API_V4_URLまたはhttps://gitlab.com/api/v4 | GitLab APIベースURL。CI_API_V4_URLが設定されている場合はそちらを優先 | なし（環境変数のみ） | - |
| GitLab | GITLAB_TOKEN | Yes | - | GitLab APIトークン（秘密情報） | --gitlab-token | - |
| GitLab | GITLAB_PROJECT_ID | Yes | - | GitLabプロジェクトID | --project-id | - |
| GitLab | GITLAB_MR_IID | Yes | - | マージリクエストIID | --mr-iid | - |
| 入力 | CHECKLIST_PATH | Yes | - | チェックリストファイルパス | --checklist | - |
| 入力 | REVIEW_SETTINGS_PATH | No | - | レビュー設定ファイルパス | --review-settings | - |
| 入力 | SKILLS_PATH | No | - | skillsパス | --skills | - |
| 動作設定 | USER_ID | Yes | - | 実行ユーザID | --user-id | - |
| 動作設定 | AIKATA_LOG_LEVEL | No | info | ログレベル | --log-level | - |
| 動作設定 | PRETTY_PRINT | No | true | pino-prettyによるログ整形出力の有効/無効 | --pretty-print / --no-pretty-print | - |
| 動作設定 | COMMENT_LANGUAGE | No | Japanese | レビューコメントの言語 | --comment-language | - |
| 動作設定 | TREE_MAX_DEPTH | No | 無制限 | フォルダツリー走査の最大深度。正の整数を指定。未指定時は深さ制限なし（エントリ数制限のみ適用） | なし（環境変数のみ） | - |
| 環境 | CI_PROJECT_DIR | No | process.cwd() | プロジェクトルートディレクトリ。Workspace（ファイルシステム・サンドボックス）のベースパスとして利用。CI環境では自動設定 | なし（環境変数のみ） | - |
