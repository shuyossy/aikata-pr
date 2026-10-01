# 環境変数設計

本アプリは環境変数で様々な挙動の制御が可能

| カテゴリ | 変数名 | 必須 | 既定値 | 主な制御内容 | CLIオプション | 参照箇所 |
| --- | --- | --- | --- | --- | --- | --- |
| バージョン | AIKATA_PR_VERSION | APIモード時必須 | latest | CLIとAPIサーバーのバージョン整合性チェック用。APIモード時にHTTPヘッダ `X-Aikata-Version` としてAPIサーバーに送信される。不一致時は409エラー | なし（環境変数のみ） | - |
| AI | AI_API_KEY | ローカルモード時必須 | - | AI APIキー（秘密情報）。AI_API_ENDPOINT_URL、AI_MODEL_NAMEと共に全て設定するとローカルモードで動作 | なし（環境変数のみ） | - |
| AI | AI_API_ENDPOINT_URL | ローカルモード時必須 | - | AI APIエンドポイントURL。AI_API_KEY、AI_MODEL_NAMEと共に全て設定するとローカルモードで動作 | なし（環境変数のみ） | - |
| AI | AI_MODEL_NAME | ローカルモード時必須 | - | AIモデル名。AI_API_KEY、AI_API_ENDPOINT_URLと共に全て設定するとローカルモードで動作 | --ai-model-name | - |
| AI | OPENAI_REASONING_EFFORT | No | - | OpenAI reasoningモデルのreasoning effort（low/medium/high）。設定時はtemperature=1も自動適用 | なし（環境変数のみ） | - |
| GitLab | GITLAB_API_URL | No | https://gitlab.com/api/v4（CI環境では`CI_API_V4_URL`が自動付与されfallback） | GitLab APIベースURL。CLIで解決後、APIモード時はリクエストボディに乗せてAPIサーバへ送る（マルチGitLabインスタンス対応）。優先順位: `--gitlab-api-url` > `GITLAB_API_URL` > `CI_API_V4_URL` > 既定値 | --gitlab-api-url | - |
| GitLab | AIKATA_PR_GITLAB_TOKEN | Yes | - | GitLab APIトークン（秘密情報） | --aikata-pr-gitlab-token | - |
| GitLab | GITLAB_PROJECT_ID | Yes | - | GitLabプロジェクトID | --project-id | - |
| GitLab | GITLAB_MR_IID | reviewで必須 | - | マージリクエストIID（review機能で必須） | --mr-iid | - |
| GitLab | GITLAB_PIPELINE_ID | pipeline-reportで必須 | - | 分析対象のパイプラインID（pipeline-report機能で必須。CI環境では `CI_PIPELINE_ID` を `.ci-template/variable/pipeline-report.yml` で継承） | --pipeline-id | - |
| GitLab | GITLAB_SELF_JOB_ID | No | - | 本機能自身のジョブID。分析対象から除外される（pipeline-report専用。CI環境では `CI_JOB_ID` を `.ci-template/variable/pipeline-report.yml` で継承） | --self-job-id | - |
| 入力 | CHECKLIST_PATH | reviewで必須 | - | チェックリストファイルパス。拡張子が`.md`/`.markdown`の場合はMarkdownテーブル、それ以外はCSVとして読み込む | --checklist | - |
| 入力 | CHECKLIST_COLUMNS | No | - | チェックリストの抽出列番号（カンマ区切り、1始まり）。未指定時は全列を抽出 | --checklist-columns | - |
| 入力 | CHECKLIST_NO_HEADER | No | false | 抽出列が1列の場合にヘッダを除外するか | --checklist-no-header | - |
| 入力 | CHECKLIST_DISPLAY_COLUMNS | No | - | レビュー結果コメントに表示する列番号（カンマ区切り、1始まり）。未指定時は `CHECKLIST_COLUMNS` と同じ列を使用（＝AIへの指示文と同一表示） | --checklist-display-columns | - |
| 入力 | REVIEW_SETTINGS_PATH | No | - | レビュー設定ファイルパス | --review-settings | - |
| 入力 | PIPELINE_REPORT_SETTINGS_PATH | No | - | pipeline-report 分析設定ファイルパス（JSON）。`jobReportFormat` / `analysisInstructions` / `reportRefinementInstructions` / `includeJobPatterns` / `excludeJobPatterns` | --pipeline-report-settings | - |
| 入力 | SKILLS_PATH | No | - | skillsパス | --skills | - |
| 動作設定 | USER_ID | Yes | - | 実行ユーザID | --user-id | - |
| 動作設定 | AIKATA_LOG_LEVEL | No | info | ログレベル | --log-level | - |
| 動作設定 | PRETTY_PRINT | No | true | pino-prettyによるログ整形出力の有効/無効 | --pretty-print / --no-pretty-print | - |
| 動作設定 | COMMENT_LANGUAGE | No | Japanese | AI出力（レビューコメント・pipeline-reportレポート）の言語 | --comment-language | - |
| 動作設定 | TREE_MAX_DEPTH | No | 無制限 | フォルダツリー走査の最大深度。正の整数を指定。未指定時は深さ制限なし（エントリ数制限のみ適用） | なし（環境変数のみ） | - |
| 動作設定 | MAX_CONTEXT_LENGTH | No | - | AIモデルのコンテキスト長（トークン数）。設定時、userプロンプトのトークン数がMAX_CONTEXT_LENGTH*0.6を超える場合にdiffを自動圧縮する。未設定時は圧縮しない。**ローカルモード専用。APIモード時はAPIサーバー側で管理** | なし（環境変数のみ） | - |
| 環境 | CI_PROJECT_DIR | No | process.cwd() | プロジェクトルートディレクトリ。Workspace（ファイルシステム・サンドボックス）のベースパスとして利用。CI環境では自動設定 | なし（環境変数のみ） | - |
| APIモード | AIKATA_API_URL | APIモード時必須 | - | APIサーバーのURL。AI_API_KEY、AI_API_ENDPOINT_URL、AI_MODEL_NAMEが全て未設定の場合はAPIモードとなり本変数が必須（review/pipeline-report共通） | --aikata-api-url | - |
| APIモード | AIKATA_JWT | APIモード時必須 | - | GitLab CI/CDのid_tokensで自動生成されるJWTトークン。APIモード時に必要（review/pipeline-report共通） | なし（環境変数のみ） | - |
| pipeline-report | PIPELINE_REPORT_RESULT_FILE | No | ./aikata-pipeline-report.md | レポート出力ファイルパス。artifactsとして保存される | --result-file | - |
| pipeline-report | PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES | No | 3 | 完成判定ループの上限回数 | --max-completeness-retries | - |
| pipeline-report | PIPELINE_REPORT_SKIP_COMPLETENESS_CHECK | No | false | 完成判定ステップをスキップする（true: 分析1回のみで判定なし） | --skip-completeness-check | - |
| pipeline-report | PIPELINE_REPORT_MAX_ARTIFACT_ZIP_MB | No | 50 | 1ジョブのartifacts zipダウンロード上限MB | なし（環境変数のみ） | - |
| pipeline-report | PIPELINE_REPORT_TOTAL_ARTIFACT_DISK_MB | No | 500 | 全ジョブ合計のartifacts zipディスク使用量上限MB | なし（環境変数のみ） | - |
| pipeline-report | PIPELINE_REPORT_MAX_ARTIFACT_FILE_BYTES | No | 2097152 | `getArtifactContent`ツールが単一ファイルから読み取る最大バイト数 | なし（環境変数のみ） | - |

## APIサーバー専用環境変数

APIサーバー（`docker/prod/docker-compose.yml`）で設定する環境変数。CLI側では不要。

| カテゴリ | 変数名 | 必須 | 既定値 | 主な制御内容 |
| --- | --- | --- | --- | --- |
| バージョン | AIKATA_PR_VERSION | Yes | - | APIサーバーのバージョン。CLI側から送信される `X-Aikata-Version` ヘッダと照合し、不一致時は409 Conflictを返す |
| AI | AI_API_KEY | Yes | - | AI APIキー（APIサーバー側で一元管理） |
| AI | AI_API_ENDPOINT_URL | Yes | - | AI APIエンドポイントURL |
| AI | AI_MODEL_NAME | Yes | - | AIモデル名 |
| AI | OPENAI_REASONING_EFFORT | No | - | OpenAI reasoningモデルのreasoning effort（low/medium/high） |
| JWT | JWT_JWKS_URL | Yes | - | GitLabのJWKSエンドポイントURL |
| JWT | JWT_AUDIENCE | Yes | - | JWT audience値 |
| JWT | JWT_ISSUER | Yes | - | JWT issuer値（GitLabインスタンスURL） |
| レート制限 | AI_API_RATE_LIMIT_PER_MIN | No | 60 | 1分間あたりのAI API発行上限 |
| クローン | MAX_CONCURRENT_CLONES | No | 5 | 同時クローン数上限 |
| クローン | CLONE_TIMEOUT_MS | No | 300000 | クローンタイムアウト（ミリ秒） |
| クローン | CLONE_MAX_DISK_MB | No | 1024 | クローンディスク使用量上限（MB） |
| タイムアウト | REVIEW_TIMEOUT_MS | No | 3600000 | レビュー全体タイムアウト（ミリ秒） |
| サーバー | API_PORT | No | 3000 | APIサーバーのリッスンポート |
| ログ | AIKATA_LOG_LEVEL | No | info | ログレベル |
| 動作設定 | MAX_CONTEXT_LENGTH | No | - | AIモデルのコンテキスト長（トークン数）。設定時、userプロンプトのトークン数がMAX_CONTEXT_LENGTH*0.6を超える場合にdiffを自動圧縮する。未設定時は圧縮しない |
