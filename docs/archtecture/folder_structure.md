# フォルダ構成

本プロジェクトは1パッケージで複数のAI CIジョブ（「機能」）をホストできる構造を採っている。
レイヤーファースト構造を維持しつつ、各層に `shared/` と `<feature>/` サブフォルダを配置する。
`<feature>` 名は現時点では `review` のみ。将来新機能を追加する際は `docs/archtecture/feature-extension.md` を参照。

```
.ci-template/ # CIテンプレート（別プロジェクトへの提供用）
  pipelines/
    template.yml            # ファサード（既存ユーザ向け後方互換、review をinclude）
    template-npx.yml        # ファサード（npx方式）
    review/
      template.yml          # review機能の実体（Docker方式）
      template-npx.yml      # review機能の実体（npx方式）
  variable/
    variables.yml           # ファサード（shared.yml + review.yml をinclude）
    shared.yml              # 全機能横断のCI変数デフォルト
    review.yml              # review固有のCI変数デフォルト
.gitlab-ci.yml              # 本プロジェクト自身のCI/CD定義
dist/
  index.js                  # CLIエントリーポイント（bin: aikata-pr）
  server.js                 # APIサーバーエントリーポイント
docker/
  prod/                     # 本番用コンテナ構成
src/
  cli.ts                    # CLIエントリ（サブコマンドディスパッチャ呼び出し）
  server.ts                 # APIサーバエントリ（features配列でルート登録）
  cli/
    dispatch.ts             # サブコマンドディスパッチャ本体
    shared/                 # CLI横断の共通ヘルパ（将来用）
    review/                 # review機能のCLI実装
      index.ts              # reviewCliModule + run(args)
      parseReviewArgs.ts    # review固有の引数パース
      commandBuilder.ts     # ReviewCommand/ReviewApiRequest組み立て
      __tests__/
  domain/                   # ドメイン層
    shared/                 # 全機能横断のドメイン（将来用）
    review/                 # review機能のドメイン
      checkItem/
      checklist/
      mrContext/
      qualityGate/
      rating/
      reviewResult/
      reviewSettings/
  application/              # アプリケーション層
    shared/                 # 全機能横断のアプリケーションコード
      port/                 # ゲートウェイ・ワークフロー・クローン等のポート
      comment/              # コメント整形・パーサー
      parser/               # チェックリスト・レビュー設定パーサー
      prompt/               # プロンプトビルダー
      diffCompression/      # diff圧縮
    review/
      reviewExecution/      # ReviewExecutionService
      commentPosting/       # CommentPostingService
  presentation/
    api/
      index.ts              # shared + review のバレルre-export
      shared/               # 全機能横断のAPI基盤
        featureModule.ts    # ApiFeatureModule インターフェース（汎用）
        requestIdMiddleware.ts
        index.ts
      review/               # review機能のAPIルート・ハンドラ
        reviewRoute.ts
        reviewHandler.ts
        index.ts            # reviewApiModule + バレルexport
  mastra/                   # Mastra層（AIワークフロー実行基盤）
    index.ts                # Mastraオブジェクト組み立て
    shared/
      requestContext.ts     # AsyncLocalStorageベースのリクエストコンテキスト
    review/
      agents/               # AIエージェント定義
      tools/                # ツール定義
      workflows/            # ワークフロー定義
      indexedCheckItem.ts
      types.ts
  infrastructure/
    adapter/
      httpClient/           # GitLab APIクライアント等（shared）
      auth/                 # JWT認証ミドルウェア（shared）
      clone/                # リポジトリクローン管理（shared）
      rateLimiter/          # レート制御（shared）
      tokenCounter/         # トークンカウンター（shared）
      gateway/              # MR差分取得・プロジェクトツリー等の汎用gateway
      review/               # review固有のアダプタ
        gateway/            # GitLabMrDiscussionGateway（コメント投稿）
        apiClient/          # ReviewApiClient（CLI→APIサーバのSSE）
        workflow/           # MastraReviewWorkflowRunner
  lib/                      # 横断的な汎用ロジック（logger, errorClassifier等）
docs/
  domain/
    glossary.md             # 横断用語インデックス
    review/                 # review機能のドメインドキュメント
      entity.md
      business_rule.md
      usecase.md
      glossary.md
  archtecture/
    tech.md                 # 横断アーキテクチャ
    folder_structure.md     # 本ファイル
    feature-extension.md    # 新機能追加ガイド
    overallflow_concept.md
    logger-investigation.md
  config/
    env_val.md
  plans/                    # 設計書・実装計画の保存先
```

## レイヤールール
- `shared/` は `<feature>/` を参照しない（依存方向を守る）
- `<feature>/` は `shared/` を参照して良い
- 同一feature内ではクリーンアーキテクチャの依存方向（Presentation → Application → Domain）を守る
- 異なるfeature同士は直接参照しない（将来機能間連携が必要になった時は `shared/` に抽出する）
