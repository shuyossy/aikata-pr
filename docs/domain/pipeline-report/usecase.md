# ユースケース
記載フォーマット
```
- ユースケース名
  - 識別子: [英語で記載、実装するクラス名と同じにする] ※~Serviceとすること
  - 前提条件
    - [箇条書き]
  - 入力: [入力内容を簡潔に記載]
  - 出力: [出力内容を簡潔に記載]
  - メインフロー
    1. [番号付き箇条書き]
  - 例外
    - パターン1: [条件を記載]
      - [結果(アクション)を箇条書き]
    - パターン2: ...
  - 事後処理
    - [事後処理があれば箇条書きで記載]
```

---

- パイプライン分析
  - 識別子: PipelineAnalysisService
  - 前提条件
    - GitLab APIトークンが有効
    - AI APIキーとエンドポイントが有効（ローカルモード時。APIモード時はAPIサーバー側で保持）
    - 対象の `$CI_PIPELINE_ID` が存在すること
    - 本ジョブ自身は `.post` ステージで `when: always` により起動され、先行ジョブが終了している想定
  - 入力: PipelineAnalysisCommand（userId, projectId, pipelineId, selfJobId, gitlabToken, settings (PipelineReportSettings), skillsPaths, projectDir, aiApiKey, aiApiEndpointUrl, aiModelName, treeMaxDepth, commentLanguage, openaiReasoningEffort, maxContextLength, maxCompletenessRetries, resultFilePath）
  - 出力: PipelineAnalysisDto（reportContent, completenessVerified, completenessRetries）
  - メインフロー
    1. `pipelineGateway.getPipeline(projectId, pipelineId)` でパイプラインメタ情報を取得
    2. `pipelineGateway.getJobs(projectId, pipelineId, { includeRetried: false })` で全ジョブを取得
    3. `settings.filterJobs(allJobs, selfJobId)` で分析対象ジョブを選定（self 除外 → include → exclude）
    4. 各対象ジョブのログを `pipelineGateway.getJobTrace(projectId, jobId)` で並列取得
    5. `ArtifactCacheManager.prefetchForJobs(projectId, filteredJobs)` で artifacts zip を並列ダウンロード・キャッシュ（1 ジョブ上限 / 合計ディスク上限を尊重）
    6. 各 zip を `ArtifactArchiveReader.listEntries(zipPath)` でパースし `ArtifactTree[]` に変換
    7. `projectTreeGateway.getFolderTree(projectDir, treeMaxDepth)` でソースコードのフォルダツリーを取得
    8. `pipelineContextBuilder.build(...)` で PipelineContext（Pipeline + Jobs + JobLogs + ArtifactTrees + folderTree + settings）を構築
    9. 閾値超過判定の上、`JobLogCompressor.compress(...)` で段階的圧縮（best-effort）
    10. `resultFilePath` に `OVERALL_REPORT_TEMPLATE` を書き込み（レポートファイル初期化）
    11. `workflowRunner.run(...)` で Mastra workflow を実行
        - 内部で `executeAnalysisStep` → `verifyCompletenessStep` を反復し、`maxCompletenessRetries` まで完成判定ループを回す
    12. 完了後 `resultFilePath` の内容を読み出し、`AnalysisReport.of(content)` を生成して DTO で返却
    13. `finally` で `ArtifactCacheManager.cleanup()` により temp ディレクトリを削除
  - 例外
    - パターン1: GitLab API 失敗（`getPipeline` / `getJobs` / `getJobTrace` / `downloadArtifactArchive`）
      - 例外をスローし、CLI/APIハンドラ側で exit(1) / SSE error イベントとして伝播
    - パターン2: zip ダウンロード / パース失敗
      - `PipelineReportArtifactArchiveError` を投げる
      - 部分的に取得できたジョブ分は保持したまま、該当ジョブのみ artifacts なしとして分析を続行するか、重大失敗時はエラー終了とするかを呼び出し側のポリシーで判断（現設計は呼び出し側でのハンドリング）
    - パターン3: Mastra workflow 実行エラー（AI API 呼び出しエラーなど）
      - 例外をスローし、CLI/APIハンドラ側で exit(1) / SSE error イベントとして伝播
    - パターン4: コンテキスト長エラー
      - `contextLengthRecovery` が要約 → 継続を最大 3 回ループ。ループ上限に達した場合は Mastra workflow エラーとして上位へ伝播
    - パターン5: 完成判定ループ上限到達
      - 例外は投げない。warning ログを出し、現状の `resultFilePath` の内容を `AnalysisReport` として返却
  - 事後処理
    - `ArtifactCacheManager.cleanup()` で temp ディレクトリを削除
    - CLI 側ではレポートを stdout にフラッシュし、artifacts 指定パスに Markdown ファイルが残る

- レポート出力・終了制御
  - 識別子: pipelineReportCliModule
  - 前提条件
    - `PipelineAnalysisService` または `PipelineReportApiClient` から `reportContent` が得られていること
  - 入力: 実行モード（local / api）, ReportContent, completenessVerified, completenessRetries
  - 出力: 終了コードと artifacts ファイル
  - メインフロー
    1. `resultFilePath` に Markdown レポートを保存（サービスが書き込み済みのファイルを再確認）
    2. レポート全文を stdout にフラッシュ
    3. `completenessVerified=false` の場合は stderr に warning を記録
    4. exit(0)
  - 例外
    - パターン1: サービス例外発生時
      - stderr に時刻 + userId + スタックトレース（英語）を出力して exit(1)
  - 事後処理
    - ロガーの flush
