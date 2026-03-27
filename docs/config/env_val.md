# 環境変数設計

本アプリは環境変数で様々な挙動の制御が可能

| カテゴリ | 変数名 | 必須 | 既定値 | 主な制御内容 | CLIオプション | 参照箇所 |
| --- | --- | --- | --- | --- | --- | --- |
| AI | AI_API_KEY | Yes | - | AI APIキー（秘密情報） | なし（環境変数のみ） | - |
| AI | AI_API_ENDPOINT_URL | Yes | - | AI APIエンドポイントURL | なし（環境変数のみ） | - |
| GitLab | GITLAB_API_TOKEN | Yes | - | GitLab APIトークン（秘密情報） | なし（環境変数のみ） | - |
| GitLab | GITLAB_PROJECT_ID | Yes | - | GitLabプロジェクトID | --project-id | - |
| GitLab | GITLAB_MR_IID | Yes | - | マージリクエストIID | --mr-iid | - |
| 入力 | CHECKLIST_PATH | Yes | - | チェックリストファイルパス | --checklist | - |
| 入力 | REVIEW_SETTINGS_PATH | No | - | レビュー設定ファイルパス | --review-settings | - |
| 入力 | SKILLS_PATH | No | - | skillsパス | --skills | - |
| 動作設定 | USER_ID | Yes | - | 実行ユーザID | --user-id | - |
| 動作設定 | LOG_LEVEL | No | info | ログレベル | --log-level | - |
| 動作設定 | VERBOSE_ERROR | No | false | エラーログ詳細表示の有無 | --verbose-error | - |
