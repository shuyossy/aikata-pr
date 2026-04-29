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
本プロジェクトはAIレビュー以外の機能も同一パッケージでホストできる「マルチ機能ホスト」構成を採用している。新機能の追加手順は `docs/archtecture/feature-extension.md` を参照。

CLIはサブコマンド方式で動作する。`aikata-pr review [options]` のように機能名サブコマンドを必須とし、`src/cli/dispatch.ts` のディスパッチャが対象機能の `CliFeatureModule.run(args)` を呼び出す。現時点では `review`（MRのAIレビュー）、`pipeline-report`（CIパイプライン結果のAI分析レポート生成）、`server`（APIサーバー起動）の3サブコマンドが登録されている。

各機能はローカル/APIの2モードで動作する:
- **ローカルモード**: `AI_API_KEY`、`AI_API_ENDPOINT_URL`、`AI_MODEL_NAME`が全て設定されている場合。CLIが全処理をローカルで実行する（開発用・後方互換）
- **APIモード**: 上記3変数のいずれかが未設定の場合。CLIは外部APIサーバー（`AIKATA_API_URL`）にAI実行を委譲する
  - review機能: レビュー実行をAPIに委譲し、コメント投稿・品質ゲート評価はCLI側で実行する
  - pipeline-report機能: 分析実行をAPIに委譲し、最終レポートをSSEで受け取ってartifacts出力・stdoutフラッシュはCLI側で実行する
  - いずれも `AIKATA_API_URL`と`AIKATA_JWT`が必要（両機能で同じURL・同じJWTを共有）
  - `JWT_*`が設定されてない場合は、JWT認証無効で動作する（開発時のみ許容、デバッグ用）

#### APIモードのSSE接続耐性
セルフホストGitLab環境のネットワーク制約（プロキシ/LBでのリクエストdrop、長時間接続のidle timeout等）により、SSE接続が中断される事象に対応するため以下の機構を備える。

1. **fetch自動リトライ + Idempotency-Key**:
  - CLIはリクエストセット開始時にUUID v4の`X-Idempotency-Key`を1度だけ生成し、リトライ時も同じキーで送信する
  - 接続失敗（ネットワークエラー・5xx）時は最大`JOB_FETCH_RETRY_COUNT`回（既定5回）、指数バックオフ + ジッタでリトライする
  - APIサーバはIdempotency-Keyで既存ジョブを検索し、既存ジョブがあれば結果（or 既存jobId）を返してAI処理重複を防止する
2. **ジョブ結果の永続化（`pending`/`success`/`failed`）**:
  - APIサーバはジョブ状態と最終結果をファイルベースで永続化（`JOB_RESULT_STORE_DIR`、TTL `JOB_RESULT_TTL_MS`）。シングルインスタンス前提
  - SSEで`result`を送信する直前に`success`保存、catch内で`failed`保存（best-effort）
3. **GET /api/v1/jobs/{jobId} による結果再取得**:
  - SSEヘッダ受信後の切断時、CLIは同一jobIdで結果取得APIを指数バックオフでポーリングする
  - 連続404が`JOB_RESULT_POLL_NOT_FOUND_GRACE_MS`（既定60秒）続いたら「処理未開始」として早期中断＋再実行案内
  - 認可: JWT有効モードはJWT `user_login`、JWT無効モードはクエリパラメータ`?userId=xxx`と保存`userId`を一致確認
4. **マルチインスタンス運用への拡張**:
  - 現行はシングルインスタンス前提。複数台運用時は`JOB_RESULT_STORE_DIR`を共有FSにマウントするか、将来導入予定の`LibSqlJobResultStore`等の共有ストアに差し替えること

### 機能モジュール登録パターン
各機能は2種類のモジュールをエクスポートし、それぞれCLI/APIサーバ起動時にレジストリに登録される。
- **CliFeatureModule**: `{ name, description, run(args) }`。`src/cli/dispatch.ts` の `defaultFeatures = [reviewCliModule, pipelineReportCliModule, serverCliModule]` に追加
- **ApiFeatureModule**: `{ name, register(app) }`。`src/server.ts` の `apiFeatures = [reviewApiModule, pipelineReportApiModule]` に追加
- 新機能を追加する場合は、各レイヤーに `<feature>/` フォルダを作成した上で、両配列にモジュールを追加するだけで配線が完了する

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
    - PipelineAnalysisService: AIパイプライン分析（Pipeline/Jobs/JobTrace/Artifacts取得→圧縮→Workflow実行→レポート返却）。APIサーバー側で使用
- インフラ層
  - Mastra層（`src/mastra`）についてはAIワークフロー実行基盤としてインフラ層の一種とみなす※ポートは`src/application/shared/port/workflow`
- プレゼンテーション層
  - CLIインターフェース: `node dist/index.js <feature> [options]`（例: `node dist/index.js review --user-id ...`）。サブコマンドは必須で、`src/cli/dispatch.ts` のディスパッチャが対応する `CliFeatureModule` を呼び出す
  - APIサーバーインターフェース: `node dist/index.js server`（または `aikata-pr server`）
    - Honoフレームワーク
    - `POST /api/v1/review` — SSEストリーミングレスポンス（review機能）
    - `POST /api/v1/pipeline-report` — SSEストリーミングレスポンス（pipeline-report機能）
    - `GET /api/v1/jobs/{jobId}` — ジョブ結果再取得（SSE切断時のフォールバック用、feature横断）
    - JWT認証ミドルウェア（GitLab CI/CD `id_tokens`を検証）
  - 全パラメータはCLIオプションと環境変数の両方で指定可能（優先順位: CLIオプション > 環境変数 > デフォルト値）
  - 共通CLIオプション（環境変数フォールバック付き）
    - `--user-id` / `USER_ID`: 実行ユーザID
    - `--project-id` / `GITLAB_PROJECT_ID`: GitLabプロジェクトID
    - `--skills` / `SKILLS_PATH`: skillsパス
    - `--aikata-pr-gitlab-token` / `AIKATA_PR_GITLAB_TOKEN`: GitLab APIトークン
    - `--ai-model-name` / `AI_MODEL_NAME`: AIモデル名（デフォルト: `openai/o4-mini`）
    - `--log-level` / `AIKATA_LOG_LEVEL`: ログレベル
    - `--comment-language` / `COMMENT_LANGUAGE`: AI出力（レビューコメント/レポート）の言語（デフォルト: `Japanese`）
    - `--aikata-api-url` / `AIKATA_API_URL`: APIサーバーURL（設定時はAPIモードで動作）
  - review サブコマンド固有CLIオプション
    - `--mr-iid` / `GITLAB_MR_IID`: MR IID
    - `--checklist` / `CHECKLIST_PATH`: チェックリストファイルパス
    - `--checklist-columns` / `CHECKLIST_COLUMNS`: チェックリストCSVの抽出列番号（カンマ区切り、1始まり）
    - `--checklist-no-header` / `CHECKLIST_NO_HEADER`: 抽出列が1列の場合にヘッダを除外するか（デフォルト: `false`）
    - `--review-settings` / `REVIEW_SETTINGS_PATH`: レビュー設定ファイルパス
  - pipeline-report サブコマンド固有CLIオプション
    - `--pipeline-id` / `GITLAB_PIPELINE_ID` / `CI_PIPELINE_ID`: 分析対象のパイプラインID
    - `--self-job-id` / `GITLAB_SELF_JOB_ID` / `CI_JOB_ID`: 本ジョブ自身のジョブID（分析対象から除外される）
    - `--pipeline-report-settings` / `PIPELINE_REPORT_SETTINGS_PATH`: 分析設定ファイルパス（JSON）
    - `--result-file` / `PIPELINE_REPORT_RESULT_FILE`: レポート出力ファイルパス（デフォルト: `./aikata-pipeline-report.md`）
    - `--max-completeness-retries` / `PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES`: 完成判定ループ上限（デフォルト: `3`）
    - `--skip-completeness-check` / `PIPELINE_REPORT_SKIP_COMPLETENESS_CHECK`: 完成判定ステップをスキップする（デフォルト: `false`）
  - 環境変数のみ（秘密情報・環境固有）
    - `AI_API_KEY`: AI APIキー（ローカルモード時のみ必要、APIモード時はAPIサーバー側で管理）
    - `AI_API_ENDPOINT_URL`: AI APIエンドポイントURL（同上）
    - `AIKATA_JWT`: GitLab CI/CDのid_tokensで自動生成されるJWTトークン（APIモード時に使用）
    - `PIPELINE_REPORT_MAX_ARTIFACT_ZIP_MB`: 1ジョブのartifacts zipダウンロード上限MB（pipeline-report専用、デフォルト: `50`）
    - `PIPELINE_REPORT_TOTAL_ARTIFACT_DISK_MB`: artifacts zipの合計ディスク上限MB（pipeline-report専用、デフォルト: `500`）
    - `PIPELINE_REPORT_MAX_ARTIFACT_FILE_BYTES`: `getArtifactContent`ツールが返す1ファイル最大バイト数（pipeline-report専用、デフォルト: `2097152`）
    - SSE接続耐性関連（CLI側）
      - `JOB_FETCH_RETRY_COUNT`: fetch（POST）の最大リトライ回数（デフォルト: `5`）
      - `JOB_FETCH_RETRY_BASE_MS`: fetchリトライの初期待機時間（デフォルト: `1000`）
      - `JOB_FETCH_RETRY_MAX_MS`: fetchリトライの最大待機時間（デフォルト: `16000`）
      - `SSE_IDLE_TIMEOUT_MS`: SSE進捗イベント無音許容時間（デフォルト: `60000`）
      - `JOB_RESULT_POLL_INTERVAL_MS`: フォールバックポーリングの初期間隔（デフォルト: `5000`）
      - `JOB_RESULT_POLL_TIMEOUT_MS`: フォールバックポーリング全体上限（デフォルト: `2100000` = 35分）
      - `JOB_RESULT_POLL_NOT_FOUND_GRACE_MS`: ポーリング中の連続404継続時間（デフォルト: `60000`）。これを超えたら処理未開始と判断
    - SSE接続耐性関連（APIサーバ側）
      - `JOB_RESULT_STORE_DIR`: ジョブ結果の保存ディレクトリ（デフォルト: `${os.tmpdir()}/aikata-pr-job-results`）
      - `JOB_RESULT_TTL_MS`: ジョブ結果の保持期間（デフォルト: `86400000` = 24時間）
      - `JOB_RESULT_SWEEP_INTERVAL_MS`: 期限切れジョブの掃除間隔（デフォルト: `3600000` = 1時間）

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

## CLI実行時
`src/lib/logger.ts`の`initializeLogger({ userId })`でシングルトンロガーを生成し、`--user-id`/`USER_ID`（提供用CIテンプレートでは`$GITLAB_USER_LOGIN`）を全ログにバインドする。

## APIサーバー実行時
APIサーバーは複数ユーザからのリクエストを処理するため、シングルトンロガーに固定のuserIdをバインドしてしまうと「本テンプレートを実行したユーザ」をログから識別できない。このため以下の方式を採用している:

- **`AsyncLocalStorage`ベースのリクエスト単位バインディング**: `src/lib/logger.ts`の`runWithLogContext(bindings, fn)`を用いて、リクエストハンドラ内部で追加バインディングを確立する。同じ非同期チェーン内の`getLogger()`呼び出しは、下流のインフラ層（CloneManager、Gateway、Mastra workflow等）に至るまで自動的にバインディングが適用された子ロガーを返す。
- **ユーザ情報の主ソース**: リクエストボディの`userId`（CLIから渡される`$GITLAB_USER_LOGIN`相当）。JWT認証をスキップする開発モードでも取得可能。
- **ユーザ情報の補助ソース**: JWT認証有効時は`jwtPayload`から`user_id`/`user_email`/`project_path`/`pipeline_id`/`job_id`を抽出し、`gitlabUserId`等として追加でログにバインドする。JWTの`user_login`とリクエストボディの`userId`が不一致の場合は警告ログを出力する（拒否はしない）。
- **リクエストID**: `src/presentation/api/shared/requestIdMiddleware.ts`で全リクエストに`requestId`（UUID v4、`X-Request-Id`ヘッダがあれば継承）を付与し、ログ/レスポンスヘッダ両方に出力する。`gitlabJobId`は任意かつJWT認証時のみ得られるため、一意な識別子として`requestId`を常時採用する。

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
