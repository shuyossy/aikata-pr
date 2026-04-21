# フォルダ構成

本プロジェクトは1パッケージで複数のAI CIジョブ（「機能」）をホストできる構造を採っている。
レイヤーファースト構造を維持しつつ、各層に `shared/` と `<feature>/` サブフォルダを配置する。
`<feature>` 名は現時点では `review`（MRのAIレビュー）と `pipeline-report`（CIパイプライン結果のAI分析レポート生成）の2つ。将来新機能を追加する際は `docs/archtecture/feature-extension.md` を参照。

```
.ci-template/ # CIテンプレート（別プロジェクトへの提供用）
  pipelines/
    template.yml            # ファサード（既存ユーザ向け後方互換、review をinclude）
    template-npx.yml        # ファサード（npx方式）
  jobs/
    review/
      template.yml          # review機能のジョブ定義（Docker方式）
      template-npx.yml      # review機能のジョブ定義（npx方式）
    pipeline-report/
      template.yml          # pipeline-report機能のジョブ定義（Docker方式）
      template-npx.yml      # pipeline-report機能のジョブ定義（npx方式）
  variable/
    variables.yml           # ファサード（shared.yml + review.yml + pipeline-report.yml をinclude）
    shared.yml              # 全機能横断のCI変数デフォルト
    review.yml              # review固有のCI変数デフォルト
    pipeline-report.yml     # pipeline-report固有のCI変数デフォルト
.gitlab-ci.yml              # 本プロジェクト自身のCI/CD定義
dist/
  index.js                  # CLIエントリーポイント（bin: aikata-pr）
  server.js                 # APIサーバーエントリーポイント
docker/
  prod/
    docker-compose.yml      # APIサーバー用docker-compose（ルートのDockerfileを使用）
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
    pipeline-report/        # pipeline-report機能のCLI実装
      index.ts              # pipelineReportCliModule + run(args)
      parsePipelineReportArgs.ts
      commandBuilder.ts     # PipelineAnalysisCommand/PipelineReportApiRequest組み立て
      __tests__/
    server/                 # APIサーバー起動のCLI実装
      index.ts              # serverCliModule + run(args)（動的importでstartServer()を呼ぶ）
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
    pipeline-report/        # pipeline-report機能のドメイン
      pipeline/             # Pipeline（値オブジェクト）
      job/                  # Job / JobStatus / JobLog
      artifact/             # ArtifactEntry / ArtifactTree
      pipelineReportSettings/ # PipelineReportSettings（filterJobsを含む）
      analysisReport/       # AnalysisReport
  application/              # アプリケーション層
    shared/                 # 全機能横断のアプリケーションコード
      port/                 # ゲートウェイ・ワークフロー・クローン等のポート（PipelineGateway / PipelineAnalysisWorkflowRunner も含む）
      comment/              # コメント整形・パーサー
      parser/               # チェックリスト・レビュー設定・pipeline-report設定パーサー
      prompt/               # プロンプトビルダー
      diffCompression/      # diff圧縮（FolderTreeStripperなどpipeline-report圧縮でも共用）
    review/
      reviewExecution/      # ReviewExecutionService
      commentPosting/       # CommentPostingService
    pipeline-report/
      pipelineAnalysis/     # PipelineAnalysisService / pipelineContextBuilder /
                            # JobLogCompressor / ArtifactArchiveReader /
                            # ArtifactCacheManager / defaultReportFormat
  presentation/
    api/
      index.ts              # shared + review + pipeline-report のバレルre-export
      shared/               # 全機能横断のAPI基盤
        featureModule.ts    # ApiFeatureModule インターフェース（汎用）
        requestIdMiddleware.ts
        index.ts
      review/               # review機能のAPIルート・ハンドラ
        reviewRoute.ts
        reviewHandler.ts
        index.ts            # reviewApiModule + バレルexport
      pipeline-report/      # pipeline-report機能のAPIルート・ハンドラ
        pipelineReportRoute.ts
        pipelineReportHandler.ts
        index.ts            # pipelineReportApiModule + バレルexport
  mastra/                   # Mastra層（AIワークフロー実行基盤）
    index.ts                # Mastraオブジェクト組み立て（review + pipeline-report のagents/workflowsを登録）
    shared/
      requestContext.ts     # AsyncLocalStorageベースのリクエストコンテキスト
      readImageCommon.ts    # 画像読み取りツール関連の共通ロジック（review / pipeline-report で共用）
    review/
      agents/               # AIエージェント定義
      tools/                # ツール定義
      workflows/            # ワークフロー定義
      indexedCheckItem.ts
      requestContext.ts     # review固有のAgent Request Context型（shared/requestContext.tsのWorkflowRequestContextを拡張）
      types.ts
    pipeline-report/
      agents/               # pipelineAnalysisAgent / reportFinalizationJudgeAgent / reportRewriteAgent / pipelineReportSummarizationAgent
      tools/                # writeReport / patchReport / getReport / getJobLogDetail / getArtifactContent
      workflows/            # pipelineAnalysisWorkflow + steps (executeAnalysisStep / reportFinalizationStep / contextLengthRecovery)
      requestContext.ts     # pipeline-report固有のAgent Request Context型
      types.ts
  infrastructure/
    adapter/
      httpClient/           # GitLab APIクライアント等（shared）
      auth/                 # JWT認証ミドルウェア（shared）
      clone/                # リポジトリクローン管理（shared）
      rateLimiter/          # レート制御（shared、review/pipeline-reportで共用インスタンス）
      tokenCounter/         # トークンカウンター（shared）
      gateway/              # MR差分取得・プロジェクトツリー等の汎用gateway
      review/               # review固有のアダプタ
        gateway/            # GitLabMrDiscussionGateway（コメント投稿）
        apiClient/          # ReviewApiClient（CLI→APIサーバのSSE）
        workflow/           # MastraReviewWorkflowRunner
      pipeline-report/      # pipeline-report固有のアダプタ
        gateway/            # GitLabPipelineGateway（Pipeline/Jobs/JobTrace/Artifacts取得）
        apiClient/          # PipelineReportApiClient（CLI→APIサーバのSSE）
        workflow/           # MastraPipelineAnalysisWorkflowRunner
  lib/                      # 横断的な汎用ロジック（logger, errorClassifier等）
docs/
  domain/
    glossary.md             # 横断用語インデックス
    review/                 # review機能のドメインドキュメント
      entity.md
      business_rule.md
      usecase.md
      glossary.md
    pipeline-report/        # pipeline-report機能のドメインドキュメント
      entity.md
      business_rule.md
      usecase.md
      glossary.md
  archtecture/
    tech.md                 # 横断アーキテクチャ
    folder_structure.md     # 本ファイル
    feature-extension.md    # 新機能追加ガイド
    logger-investigation.md # ロガー設計調査資料
    review/
      overallflow_concept.md  # review機能の処理フロー概念設計
    pipeline-report/
      overallflow_concept.md  # pipeline-report機能の処理フロー概念設計
  config/
    env_val.md
  plans/                    # 設計書・実装計画の保存先
```

## レイヤールール
- `shared/` は `<feature>/` を参照しない（依存方向を守る）
- `<feature>/` は `shared/` を参照して良い
- 同一feature内ではクリーンアーキテクチャの依存方向（Presentation → Application → Domain）を守る
- 異なるfeature同士は直接参照しない（将来機能間連携が必要になった時は `shared/` に抽出する）
