# ビジネスルール
記載フォーマット
```
- ビジネスルール名
  - 目的/背景
    - [箇条書き]
  - 条件
    - [条件(ルール内容)を箇条書き]
  - 結果(アクション)
    - [箇条書き]
  - 関連するユースケースorエンティティ:
```
---

- 分析対象ジョブ選定ルール
  - 目的/背景
    - パイプライン全体から不要なジョブ（自ジョブ・ユーザが除外指定したジョブ）を除き、AIの分析負荷を抑えつつ必要なジョブだけを確実に通す
  - 条件
    - `selfJobId` と一致するジョブ（本機能自身のレポートジョブ）を除外
    - `includeJobPatterns` が1件以上ある場合、そのいずれかにマッチするジョブ名のみ通過
    - `excludeJobPatterns` のいずれかにマッチするジョブを除外
    - 判定順序は self 除外 → include → exclude の順
  - 結果(アクション)
    - 対象 `Job[]` を返却。以降のログ取得・artifacts 取得・AI 分析の対象となる
  - 関連するユースケースorエンティティ: PipelineReportSettings.filterJobs, PipelineAnalysisService

- プロンプト圧縮ルール
  - 目的/背景
    - 大量ジョブ・長大ログを AI にそのまま渡すとコンテキスト長上限を超えてしまうため、段階的に情報量を削って閾値以下に収める
    - review 機能の `compressDiffIfNeeded` と同一アルゴリズムを採用し、保守性を揃える
  - 条件
    - 圧縮閾値 = `maxContextLength * 0.6`（review と共通）
    - Step 0: 元プロンプトのトークン数が閾値以下なら何もしない
    - Step 1: `stripFilesFromFolderTree` でフォルダツリーからファイル行を除去して再判定
    - Step 2 Phase 1: 最大ログに対し `keepPercent` を `fileKeepPercents` で下げていく（先頭/末尾を残し中央を省略）
    - Step 2 Phase 2: 全ログが `minKeepPercent` に達しても超過する場合、最大ログの `keepLines` を半減していく
    - Phase 2 を抜けても閾値超過の場合は best-effort として現状を返す（エラーは投げない）
    - アーティファクトツリーは圧縮対象外（そのまま保持）
  - 結果(アクション)
    - `{ compressed, compressedJobLogs, folderTreeStripped, strippedFolderTree, omittedJobLogs, compressedJobIds }` を返却
    - best-effort で閾値に収まらない場合は warning ログを出力し、AI API 側でのコンテキスト長エラーは `contextLengthRecovery` が要約により対応する
  - 関連するユースケースorエンティティ: JobLogCompressor, PipelineAnalysisService, contextLengthRecovery

- 省略マーカー埋込ルール
  - 目的/背景
    - 圧縮されたジョブログの中央にプレースホルダを残すことで、AI が圧縮の事実を検知し、必要に応じて `getJobLogDetail` ツールで省略部分を取り戻せるようにする
  - 条件
    - 中央省略が行われたジョブログに限り、マーカー文字列を挿入する
  - 結果(アクション)
    - 省略部分に `[aikata: N chars omitted from middle of job log. Use getJobLogDetail tool with jobId to view omitted portion]` を埋め込む
    - 元全文は `omittedJobLogs` に退避し、`getJobLogDetail` で再取得できる状態にする
  - 関連するユースケースorエンティティ: JobLogCompressor, getJobLogDetail tool

- レポートファイル初期化ルール
  - 目的/背景
    - AI が空ファイルに対して自由記述するとフォーマット崩れが起きるため、固定骨組みを先に書き込み、AI は埋めていくだけの作業に専念させる
  - 条件
    - ワークフロー開始時（`executeAnalysisStep` 冒頭）に `resultFilePath` が存在しない、または空である
  - 結果(アクション)
    - `OVERALL_REPORT_TEMPLATE`（固定骨組み）を `resultFilePath` に書き込み、以降は `writeReport` / `patchReport` ツールで Agent が更新する
  - 関連するユースケースorエンティティ: executeAnalysisStep, OVERALL_REPORT_TEMPLATE, writeReport, patchReport

- 固定レポート骨組みとユーザカスタマイズ粒度の分離ルール
  - 目的/背景
    - 全体レポートの構造（ヘッダ・サマリ・ジョブ別分析・推奨アクション）は固定し、ユーザがカスタマイズできるのはジョブ 1 件分のブロックのみに限定する
    - これによりレポート全体の見通しを担保しつつ、プロジェクト固有の観点（評価ラベル等）はユーザ側で差し替え可能にする
  - 条件
    - 全体骨組み: `OVERALL_REPORT_TEMPLATE`（ハードコード、ユーザは変更不可）
    - ジョブ 1 件分: `PipelineReportSettings.jobReportFormat`（デフォルトあり、ユーザが JSON で上書き可能）
    - AI 総合評価ラベル（`問題なし` / `要注意` / `問題あり`）はデフォルト `jobReportFormat` のプレースホルダ hint 内に定義される。ユーザが `jobReportFormat` を差し替えればラベル自体を変更できる
  - 結果(アクション)
    - Agent は全体骨組みをそのまま採用し、ジョブブロックだけを `jobReportFormat` に従って生成する
    - `reportFinalizationJudgeAgent` はジョブセクションの並び順が妥当か・ユーザの推敲指示が適用されているかを判定する
    - 仕上げが必要な場合は `reportRewriteAgent` が書き換えを実行する
  - 関連するユースケースorエンティティ: OVERALL_REPORT_TEMPLATE, PipelineReportSettings, pipelineAnalysisAgent, reportFinalizationJudgeAgent, reportRewriteAgent

- レポート最終仕上げルール
  - 目的/背景
    - レポートのソート順やユーザの推敲指示が正しく反映されているかを検証し、必要に応じて書き換えることでレポート品質を担保する
    - 仕上げ（ソート順修正・ユーザ指示に基づく書き換え等）は専用の書き換えAgentが直接対応することで効率化する
  - 条件
    - `pipelineAnalysisAgent` の 1 ラウンド終了後、`reportFinalizationJudgeAgent` に (a) 全体骨組み / (b) `jobReportFormat` / (c) 対象ジョブ一覧 / (d) 現レポート内容 / (e) `reportRefinementInstructions` を渡して JSON 判定
    - Judge 出力スキーマ: `{ finalizationNeeded: boolean, finalizationActions: string[] }`
    - `finalizationNeeded=true` の場合: `reportRewriteAgent` に現レポート内容と `finalizationActions` を渡して書き換えを実行する。書き換え時は元の文言を正確にそのまま利用することを強調する
  - 結果(アクション)
    - `finalizationNeeded=false`: そのままレポート採用
    - `finalizationNeeded=true`: `reportRewriteAgent` による書き換え後にレポート採用
  - 関連するユースケースorエンティティ: reportFinalizationStep, reportFinalizationJudgeAgent, reportRewriteAgent

- コンテキスト長リカバリールール
  - 目的/背景
    - 大量ジョブや長大ログで圧縮後も AI API のコンテキスト長上限を超える可能性があるため、review と同様に会話履歴を要約して継続できるようにする
  - 条件
    - `pipelineAnalysisAgent` 実行中にコンテキスト長エラーを検知
    - 最大 3 回まで要約→継続をループする
  - 結果(アクション)
    - `pipelineReportSummarizationAgent` で会話履歴を要約（どのジョブまで分析済みか、どのツールで何が判明したか、収集済み evidence、未完了調査項目を保持）
    - 旧スレッドを破棄し、要約を踏まえた継続プロンプトで新しいスレッドで分析を再開する
  - 関連するユースケースorエンティティ: contextLengthRecovery, pipelineReportSummarizationAgent, executeAnalysisStep

- GitLab v16 制約ルール（アーティファクト一覧取得方式）
  - 目的/背景
    - GitLab v16 では `/projects/:id/jobs/:job_id/artifacts/tree` API が提供されないため、`ArtifactEntry` 一覧を直接取得できない
  - 条件
    - 本機能は GitLab v16 以降を前提とする
  - 結果(アクション)
    - `downloadArtifactArchive` でジョブの artifacts zip を丸ごとダウンロード（サイズ上限あり）
    - `ArtifactArchiveReader.listEntries` で zip の Central Directory をパースして `ArtifactEntry` 一覧を生成
    - 個別ファイル取得も同じ zip から行う（`ArtifactArchiveReader.readFile` で先頭 `maxBytes` のみ）
    - 処理完了後、`ArtifactCacheManager.cleanup()` で temp ディレクトリを削除する
  - 関連するユースケースorエンティティ: GitLabPipelineGateway, ArtifactArchiveReader, ArtifactCacheManager

- レート制限統合ルール
  - 目的/背景
    - review と pipeline-report は同一 AI API を利用するため、レート制限（アプリ固有上限・429 エラー検知）を 2 機能で統合して扱う必要がある
  - 条件
    - どちらの機能でも共通の `RateLimiterPort` インスタンスを利用する
    - APIモード時は APIサーバー側で単一インスタンスが維持される
  - 結果(アクション)
    - 両機能の AI API 呼び出しが同じレート制限を共有し、意図せず上限を超えない
  - 関連するユースケースorエンティティ: RateLimiterPort, PipelineAnalysisService, ReviewExecutionService

- 圧縮・完成判定上限到達時のハンドリングルール
  - 目的/背景
    - 圧縮 best-effort や完成判定リトライ上限到達は「ジョブ失敗」ではなく「助言の品質低下」として扱い、CI を壊さない
  - 条件
    - `JobLogCompressor` が閾値に収まらないまま終了
    - `reportFinalizationStep` が `maxCompletenessRetries` に到達
  - 結果(アクション)
    - いずれも warning ログを出力して処理を続行
    - CLI の終了コードは `0`（通常完了扱い）
    - ただし GitLab API 失敗 / zip 失敗 / AI API 呼び出しエラーなど実行不能なエラーは `exit(1)` とする
  - 関連するユースケースorエンティティ: JobLogCompressor, reportFinalizationStep, pipelineReportCliModule

- ジョブセクション出力順序ルール
  - 目的/背景
    - レポートを見たユーザが対応すべき内容をすぐに把握できるよう、ジョブセクションを重要度順に出力する
  - 条件
    - 分析レポートの「ジョブ別分析」セクション内のジョブブロック出力順
  - 結果(アクション)
    - 以下の優先順でジョブセクションをソートするよう AI に指示する:
      1. ジョブ結果に対する AI 評価が悪い順（デフォルトテンプレートでは 問題あり → 要注意 → 問題なし）
      2. ステージの実行順（パイプライン定義上のステージ順）
    - ステージ実行順は対象ジョブのジョブ ID 昇順から導出し、AI に明示的に提示する
    - `reportFinalizationJudgeAgent` でも順序の妥当性をソフトに検証する（finalizationActions として検出）
  - 関連するユースケースorエンティティ: pipelineAnalysisAgent (buildInstructions), reportFinalizationJudgeAgent
