pipeline-report 機能（CI パイプライン結果の AI 分析レポート生成）の処理フロー概要を以下に示す。

# 業務フロー（本プロジェクトを利用するユーザ目線）
1. 任意で `pipeline-report-settings.json`（`jobReportFormat`, `analysisInstructions`, `reportRefinementInstructions`, `includeJobPatterns`, `excludeJobPatterns`）を準備する
2. `.gitlab-ci.yml` で `.ci-template/pipelines/pipeline-report/template.yml`（または `template-npx.yml`）を `include` する
   - 本ジョブは `.post` ステージで `when: always` のため、成功ジョブ・失敗ジョブを問わず同一パイプライン内の全ジョブが終了した後に実行される
3. ジョブ実行後、生成された `aikata-pipeline-report.md` が artifacts として残る
   - ジョブのログ末尾にも同じ Markdown が出力されるため、GitLab UI 上からすぐ確認できる
4. レポートにはパイプライン全体のサマリ・ジョブ別分析・推奨アクションが含まれる
   - 失敗ジョブはもちろん、GitLab 上は成功のジョブについてもログ・アーティファクトから疑わしい徴候があれば AI が検出する

# システム処理フロー

## 構成パターン
- **ローカルモード**（`AI_API_KEY`・`AI_API_ENDPOINT_URL`・`AI_MODEL_NAME` が全て設定されている場合）: CLI が `PipelineAnalysisService` を直接呼び出し、全処理をローカルで実行する（開発用・後方互換）
- **APIモード**（上記 3 変数のいずれかが未設定の場合）: CLI は外部 API サーバー（`AIKATA_API_URL`）に分析実行を委譲し、SSE で進捗と最終レポートを受け取る。AI API キーは API サーバー側で一元管理される。認証は GitLab CI/CD `id_tokens`（`AIKATA_JWT`）で行う

review 機能と同一の `AIKATA_API_URL` / `AIKATA_JWT` / `MAX_CONTEXT_LENGTH` / `TREE_MAX_DEPTH` / `AI_API_*` 環境変数を共有する。レート制限も同じ `RateLimiterPort` インスタンスを利用する。

## 全体シーケンス（ローカルモード / APIモード共通の視点）

```
CI Job (.post, when: always)
 └─ CLI (pipeline-report サブコマンド)
     ├─ 引数・環境変数パース / モード判定
     ├─ ロガー初期化 (initializeLogger({ userId }))
     ├─ [local] PipelineAnalysisService.analyze(command)
     │    └─ GitLab API / Mastra Workflow / ArtifactCacheManager 呼び出し
     ├─ [api]   PipelineReportApiClient.stream(request)
     │    └─ POST /api/v1/pipeline-report (SSE)
     │         └─ API Server: runWithLogContext → PipelineAnalysisService.analyze
     ├─ レポートを resultFilePath に保存 (artifacts に載る)
     ├─ レポート全文を stdout へフラッシュ
     └─ exit(0)
```

## PipelineAnalysisService 内部フロー

`docs/domain/pipeline-report/usecase.md` の 13 ステップを図示する。

```
analyze(command)
 1. pipelineGateway.getPipeline(projectId, pipelineId)
 2. pipelineGateway.getJobs(projectId, pipelineId, { includeRetried: false })
 3. settings.filterJobs(allJobs, selfJobId)        # self 除外 → include → exclude
 4. 並列: pipelineGateway.getJobTrace(projectId, jobId)    # ジョブログ取得
 5. artifactCacheManager.prefetchForJobs(projectId, filteredJobs)  # zip DL & キャッシュ
 6. ArtifactArchiveReader.listEntries(zipPath)           # ArtifactTree[] 構築
 7. projectTreeGateway.getFolderTree(projectDir, treeMaxDepth)
 8. pipelineContextBuilder.build(...)                    # PipelineContext 構築
 9. JobLogCompressor.compress(...)                       # 閾値超過時のみ圧縮(best-effort)
10. fs.writeFile(resultFilePath, OVERALL_REPORT_TEMPLATE) # レポートファイル初期化
11. workflowRunner.run({ targetJobs, jobLogsCompressed, omittedJobLogs,
                         artifactTrees, folderTree, folderTreeStripped,
                         pipelineMeta, overallTemplate, jobReportFormat,
                         analysisInstructions, reportRefinementInstructions, commentLanguage,
                         skillsPaths, resultFilePath, maxCompletenessRetries })
12. fs.readFile(resultFilePath) → AnalysisReport.of(content)
13. finally: artifactCacheManager.cleanup()
```

## Mastra workflow 内部フロー

`pipelineAnalysisWorkflow` は以下の 2 ステップから成り、完成判定が通るまで反復する。

```
pipelineAnalysisWorkflow
 ├─ executeAnalysisStep
 │    ├─ (初回のみ) resultFilePath に OVERALL_REPORT_TEMPLATE を書き込み
 │    ├─ userPrompt を構築
 │    │    ├─ Pipeline メタ
 │    │    ├─ Target Jobs 一覧 (id/name/stage/status/duration 等)
 │    │    ├─ Job Logs (圧縮済み or 全文)
 │    │    ├─ Artifact Trees (圧縮対象外)
 │    │    └─ Folder Tree (圧縮で files 行を stripped 済みの場合あり)
 │    ├─ pipelineAnalysisAgent.stream(userPrompt, { memory, toolsets, prepareStep })
 │    │    ├─ ReAct: Reason → Act (tool) → Observe → Record
 │    │    ├─ tools: writeReport / patchReport / getReport /
 │    │    │        getJobLogDetail (omittedJobLogs.size>0 時) /
 │    │    │        getArtifactContent / readImage (hasImages 時) /
 │    │    │        workspace tools
 │    │    └─ prepareStep: pendingImages を FileUIPart としてメッセージ列に注入
 │    ├─ コンテキスト長エラー検知時
 │    │    └─ contextLengthRecovery (最大 3 回)
 │    │         ├─ pipelineReportSummarizationAgent で履歴要約
 │    │         └─ 新スレッドで継続プロンプトを投入
 │    └─ ステップ完了 → reportFinalizationStep へ
 │
 └─ reportFinalizationStep
      ├─ fs.readFile(resultFilePath)
      ├─ reportFinalizationJudgeAgent.generate(...)
      │    └─ JSON 出力: { finalizationNeeded, finalizationActions[] }
      ├─ finalizationNeeded === false
      │    └─ workflow 完了 → { reportContent, completenessVerified: true, completenessRetries: N }
      └─ finalizationNeeded === true
           ├─ reportRewriteAgent に現レポートと finalizationActions を渡して書き換え
           └─ workflow 完了 → { reportContent, completenessVerified: true, completenessRetries: N }
```

## データフロー概略

```
GitLab API (Pipeline / Jobs / Job Trace / Artifacts Zip)
      │
      ▼
PipelineContext (Pipeline + Job[] + JobLog[] + ArtifactTree[] + folderTree)
      │
      ▼ (threshold check)
JobLogCompressor  ── omittedJobLogs (全文退避)
      │
      ▼
UserPrompt (圧縮済みコンテキスト)
      │
      ▼
pipelineAnalysisAgent  ── writeReport/patchReport ──▶ resultFilePath (Markdown)
      │
      ▼
reportFinalizationJudgeAgent (JSON) → reportRewriteAgent (書き換え、必要時のみ)
      │
      ▼
AnalysisReport (content)
      │
      ▼
CLI → stdout + artifacts 保存
```

## エラーハンドリング
- **コンテキスト長エラー**: `contextLengthRecovery` が履歴を要約して新スレッドで継続（最大 3 回）
- **完成判定ループ上限到達**: warning ログを出し、現状のレポートをそのまま返却（CLI は exit(0)）
- **圧縮 best-effort 到達**: エラーを投げず warning を出す。続くコンテキスト長エラーは上記リカバリーで対応
- **GitLab API 失敗 / zip 失敗 / AI API 呼び出しエラー**: 例外を上位に伝播し、CLI は exit(1) / SSE error イベントで失敗を通知

## 実装方針
- データ取得・圧縮・レポート初期化は `PipelineAnalysisService`（Application 層）
- AI Agent 実行・完成判定ループ・コンテキスト長リカバリーは Mastra workflow
- GitLab API 具体呼び出しは `GitLabPipelineGateway`
- アーティファクト zip の DL とキャッシュ管理は `ArtifactCacheManager`、zip パースは `ArtifactArchiveReader`
- review 機能と共有する要素は `src/application/shared/`・`src/infrastructure/adapter/<shared>/`・`src/mastra/shared/` に配置する
