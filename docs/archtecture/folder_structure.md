# フォルダ構成
※注意
- 以下のフォルダツリーにおいて、`domain/example`、`application/example`はあくまでも例です。
例を参考に、実際に必要なフォルダやファイルを作成してください。

.ci-template/ # CIテンプレート（別プロジェクトへの提供用）フォルダ
  piplines/ # パイプライン定義
    template.yml # テンプレート定義
  variable/ # 変数定義
    variables.yml #　変数の既定値
.gitlab-ci.yml # CI/CDパイプライン（本プロジェクトで利用）定義
dist/ # バンドル後のアプリを保存
  index.js # CLIエントリーポイント
  server.js # APIサーバーエントリーポイント
docker/ # Docker関連
  prod/ # 本番用
    Dockerfile # APIサーバー用Dockerイメージ
    docker-compose.yml # APIサーバー起動用
src/
  index.ts # CLIエントリーポイント
  server.ts # APIサーバーエントリーポイント
  domain/ # ドメイン層
    example/
      index.ts # エントリーポイント
      Example.ts # エンティティ
      ExampleId.ts # 値オブジェクト
  application/ # アプリケーション層
    shared/ # 全ユースケース共通して利用するフォルダ
      port/
        gateway/ # ゲートウェイIF
        workflow/ # ワークフローランナーIF
        clone/ # クローンマネージャIF
        rateLimiter/ # レートリミッターIF
      comment/ # コメント整形・パーサー
      parser/ # チェックリスト・レビュー設定パーサー
      prompt/ # プロンプトビルダー
      diffCompression/ # diff圧縮
    example/
      index.ts # エントリーポイント
      ExampleService.ts # アプリケーションサービス
  presentation/ # プレゼンテーション層
    api/ # APIサーバー用
      reviewRoute.ts # レビューAPIルート
      reviewHandler.ts # レビューハンドラ（SSE対応）
  mastra/ # mastra関連コード
    index.ts # エントリーポイント（Mastraオブジェクト作成）
    agents/ # エージェント定義
    tools/ # ツール定義
    workflows/ # ワークフロー定義
  infrastructure/ # インフラ層
    adapter/ # アダプタ
      gateway/ # ゲートウェイ実装（GitLab API、ローカルgit等）
      httpClient/ # HTTPクライアント
      auth/ # JWT認証ミドルウェア
      clone/ # リポジトリクローン管理
      rateLimiter/ # レート制御（ラウンドロビン+TokenBucket）
      apiClient/ # CLI→APIサーバー間SSEクライアント
      tokenCounter/ # トークンカウンター
  lib/ # 汎用ロジック
