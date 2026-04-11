# PBI ID:1 pipeline-report 機能 設計書

- 作成日: 2026-04-11
- 対象 PBI: `PBI.md` ID: 1 「CI結果確認ジョブの新規作成」
- ステータス: 設計承認済み（実装計画作成前）

## 1. 目的とスコープ

GitLab CI/CD パイプラインの全ジョブを AI で解析し、1 本の Markdown レポートを artifacts と標準出力に残す新機能 `pipeline-report` を追加する。これによりジョブの成功・失敗を問わず「ログを読まないと気づけない潜在的な問題」を毎回の CI で自動的に洗い出すことが目的。

既存の `review` 機能と同一パッケージでホストし、同じ AI API・同じレート制限・同じ Mastra 基盤・同じクリーンアーキテクチャ構造を共有する。

## 2. 機能名と全体方針

| 項目 | 決定事項 |
| --- | --- |
| サブコマンド名 | `pipeline-report` |
| 実行モード | ローカル/API の両モード対応（review と同じ） |
| 分析対象パイプライン | `$CI_PIPELINE_ID`（同パイプライン）。本ジョブは `.post` ステージに配置し `when: always` |
| レポート粒度 | **単一レポート × 単一 Agent**。全ジョブを 1 つのユーザプロンプトに載せて分析 |
| 対象ジョブ | 全ジョブ＋自分自身（`$CI_JOB_ID`）だけ除外。設定 JSON で include/exclude 正規表現追加可 |
| ソースコードパス取得 | review の `ProjectTreeGateway` (`TREE_MAX_DEPTH`) を流用。ローカル=`$CI_PROJECT_DIR`、API=`CloneManager` |
| プロンプト圧縮閾値 | review と共通の `MAX_CONTEXT_LENGTH`（閾値率 0.6）を再利用 |
| アーティファクト一覧 | GitLab v16 前提のため `/artifacts/tree` は使えない。zip をダウンロードして Central Directory をパース |
| コンテキスト長リカバリー | review を参考に pipeline-report 専用の要約 Agent + recovery step を新設 |
| レポート出力先 | 単一 Markdown ファイルを artifacts に配置、stdout にもフラッシュ |
| API エンドポイント | `POST /api/v1/pipeline-report`（SSE ストリーミング） |
| レポート編集系ツール | `writeReport` + `patchReport`（review の write/patch パターンに従う） |

## 3. アーキテクチャと責務分担

### 3.1 ディレクトリ構成（新設）

```
src/
  cli/pipeline-report/
    index.ts                     # pipelineReportCliModule
    parsePipelineReportArgs.ts
    commandBuilder.ts
    __tests__/
  domain/pipeline-report/
    pipeline/Pipeline.ts
    job/Job.ts
    job/JobStatus.ts
    job/JobLog.ts
    artifact/ArtifactEntry.ts
    artifact/ArtifactTree.ts
    pipelineReportSettings/PipelineReportSettings.ts
    analysisReport/AnalysisReport.ts
  application/pipeline-report/
    pipelineAnalysis/
      PipelineAnalysisService.ts
      pipelineContextBuilder.ts
      JobLogCompressor.ts
      ArtifactArchiveReader.ts
      ArtifactCacheManager.ts
      defaultReportFormat.ts
      __tests__/
  application/shared/port/
    gateway/PipelineGateway.ts              # 新規ポート
    workflow/PipelineAnalysisWorkflowRunner.ts  # 新規ポート
  application/shared/parser/
    parsePipelineReportSettings.ts          # review の parser と並列
  mastra/pipeline-report/
    agents/
      pipelineAnalysisAgent.ts
      reportCompletenessJudgeAgent.ts
      pipelineReportSummarizationAgent.ts
    tools/
      writeReport.ts
      patchReport.ts
      getReport.ts
      getJobLogDetail.ts
      getArtifactContent.ts
    workflows/
      pipelineAnalysisWorkflow.ts
      steps/
        executeAnalysisStep.ts
        verifyCompletenessStep.ts
        contextLengthRecovery.ts
    requestContext.ts
    types.ts
  infrastructure/adapter/pipeline-report/
    gateway/GitLabPipelineGateway.ts
    apiClient/PipelineReportApiClient.ts
    workflow/MastraPipelineAnalysisWorkflowRunner.ts
  presentation/api/pipeline-report/
    index.ts                                # pipelineReportApiModule
    pipelineReportRoute.ts
    pipelineReportHandler.ts

.ci-template/
  pipelines/pipeline-report/
    template.yml                            # Docker
    template-npx.yml                        # npx
  variable/pipeline-report.yml              # 新規（variables.yml からも include）

docs/
  domain/pipeline-report/
    entity.md
    business_rule.md
    usecase.md
    glossary.md
  archtecture/pipeline-report/
    overallflow_concept.md

src/cli/dispatch.ts                         # defaultFeatures に pipelineReportCliModule を追加
src/server.ts                               # apiFeatures に pipelineReportApiModule を追加
src/mastra/index.ts                         # pipeline-report 系 agents/workflow を登録
```

### 3.2 レイヤー責務

- **Presentation (CLI)**: 引数・環境変数パース、モード判定、ロガー初期化、レポートファイル出力、stdout フラッシュ、終了コード制御。
- **Presentation (API)**: SSE ルート、JWT 認証、`runWithLogContext` によるリクエスト単位ログバインディング。
- **Application**: GitLab API 経由のデータ収集、プロンプト圧縮、workflow 呼び出し、結果受領。
- **Domain**: エンティティ・値オブジェクト・ビジネスルール（ジョブフィルタ等）。
- **Mastra**: AI Agent 実行、ReAct ループ、tool 定義、コンテキスト長リカバリー、完成判定ループ。
- **Infrastructure**: GitLab API 具体呼び出し、Clone、Workflow 実行器、SSE クライアント。

### 3.3 レイヤー依存ルール

`shared/` は `<feature>/` を参照しない。`pipeline-report/` は `shared/` を参照して良い。`review/` と `pipeline-report/` 相互参照は禁止。

## 4. ドメインモデルとビジネスルール

### 4.1 エンティティ

- **`Pipeline`**: `projectId`, `pipelineId`, `ref`, `sha`, `status`, `webUrl`, `createdAt`, `updatedAt`
- **`Job`**: `id`, `name`, `stage`, `status`, `startedAt`, `finishedAt`, `duration`, `webUrl`, `failureReason`
- **`JobStatus`**: `'created'|'pending'|'running'|'failed'|'success'|'canceled'|'skipped'|'waiting_for_resource'|'manual'|'preparing'|'scheduled'`
- **`JobLog`**: `jobId`, `fullText`, `compressedText`, `omittedRange`, `totalChars`
- **`ArtifactEntry`** / **`ArtifactTree`**: `path`, `type`, `size`, `mode`（ArtifactTree は jobId ごとの配列）
- **`PipelineReportSettings`**: `jobReportFormat`, `additionalInstructions`, `includeJobPatterns: RegExp[]`, `excludeJobPatterns: RegExp[]`
- **`AnalysisReport`**: `content: string`

### 4.2 ビジネスルール

1. **分析対象ジョブの選定**（`PipelineReportSettings.filterJobs(jobs, selfJobId)`）:
   1. `selfJobId` と一致するジョブを除外
   2. `includeJobPatterns` が空でない場合、いずれかにマッチするジョブのみ通過
   3. `excludeJobPatterns` のいずれかにマッチするジョブを除外
2. **プロンプト圧縮**: review の `compressDiffIfNeeded` と同じ段階的アルゴリズム。Step 1 で folderTree のファイル項目除去 → Step 2 Phase 1 で keepPercent ベース反復 → Phase 2 で keepLines 半減反復。アーティファクトツリーは一切圧縮しない。best-effort で終わる（抜けきれなくてもエラーは投げず、コンテキスト長エラーは AI API 側のリカバリーで対応）。
3. **レポートファイルの初期化**: Agent 開始時に `OVERALL_REPORT_TEMPLATE`（固定骨組み）を `resultFilePath` に書き込み、Agent が `writeReport`/`patchReport` で埋めていく。
4. **レポート完成判定**: `pipelineAnalysisAgent` 終了後、`reportCompletenessJudgeAgent` に以下を渡して JSON で判定: 圧縮済みパイプラインコンテキスト / 全体骨組み / jobReportFormat / additionalInstructions / 対象ジョブ一覧 / 現レポート内容。`isComplete=false` なら不足項目を Agent にフィードバックして同一スレッドで再実行。上限は `PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES`（デフォルト 3）。上限到達時は警告ログを出して現状レポートを返す。

### 4.3 レポート構造（固定骨組み）

ユーザがカスタマイズできるのはジョブ 1 件分のフォーマット (`jobReportFormat`) のみ。全体骨組みは固定:

```
# パイプライン分析レポート
<ヘッダ: pipelineId / ref / sha / status / totalTargetJobs / generatedAt>

## サマリ
<overall-summary>

### ジョブステータスの内訳
<status-breakdown-rows>

## ジョブ別分析
<job-sections>

## 推奨アクション
<recommended-actions>
```

### 4.4 デフォルトの `jobReportFormat`

```
### ジョブ #<jobId> — `<jobName>` (<stage> / <status>)

- **実行時間:** <duration>
- **Web URL:** <webUrl>
- **AI 総合評価:** <以下の3つから1つだけ選ぶ: 「問題なし」「要注意」「問題あり」。「問題なし」= ログ・アーティファクトの観察範囲で特筆すべき懸念がない場合 / 「要注意」= GitLab 上は成功だが警告・スキップ・無視されたエラー等の疑わしい徴候がある、または失敗だが影響範囲が軽微な場合 / 「問題あり」= ジョブが失敗している、または成功していても明確な問題（テストスキップ、エラー握り潰し、重要なリグレッション等）が検出されている場合>

**概要**
<1〜3文でこのジョブの顛末を要約>

**検出された問題**
<箇条書きで具体的な問題を列挙。GitLab 上は成功していても、ログから疑わしい徴候が見つかれば必ず記載する。何も検出されなかった場合は「検出なし」と書く>

**根拠（ログ・アーティファクト）**
- `<ログ行またはアーティファクト抜粋>` — <なぜこれが根拠になるのか>

**推奨される次のアクション**
<具体的なアクション、または「特になし」>
```

AI 総合評価ラベルの定義は system prompt にハードコードせず、プレースホルダの hint (`<...>`) 内に内包する。ユーザが `jobReportFormat` を上書きすればラベル自体を変更可能、Judge Agent は hint の列挙型を検出して自動追従する。

## 5. Application 層

### 5.1 `PipelineAnalysisService`

依存ポート:
- `PipelineGateway`
- `ProjectTreeGateway`（review と共有）
- `PipelineAnalysisWorkflowRunner`
- `TokenCounter`（review と共有）
- `RateLimiterPort`（review と共有、API モードで同一インスタンス）
- `CloneManagerPort`（API モード時のみ）
- `ArtifactCacheManager`

主要処理フロー（`analyze(command)`）:
1. `pipelineGateway.getPipeline(projectId, pipelineId)`
2. `pipelineGateway.getJobs(projectId, pipelineId, { includeRetried: false })`
3. `settings.filterJobs(allJobs, selfJobId)`
4. 各対象ジョブのログを `pipelineGateway.getJobTrace(projectId, jobId)` で並列取得
5. `ArtifactCacheManager.prefetchForJobs(projectId, filteredJobs)` で artifacts zip を並列ダウンロード・キャッシュ（サイズ上限・合計ディスク上限を尊重）
6. 各 zip を `ArtifactArchiveReader.listEntries(zipPath)` でパースし `ArtifactTree` に変換
7. `projectTreeGateway.getFolderTree(projectDir, TREE_MAX_DEPTH)`
8. `pipelineContextBuilder.build(...)` で PipelineContext を構築
9. 閾値超過なら `JobLogCompressor.compress(...)` で段階的圧縮（best-effort）
10. `resultFilePath` に `OVERALL_REPORT_TEMPLATE` を書き込み
11. `workflowRunner.run(...)` を呼び workflow 実行（内部で完成判定ループ）
12. 完了後 `resultFilePath` を読み `AnalysisReport.of(content)` を返却
13. `finally` で `ArtifactCacheManager.cleanup()`

### 5.2 `JobLogCompressor`

review の `DiffCompressor` と同一アルゴリズム。入力: `originalJobLogs: Map<jobId, text>`, `folderTree: string`, `tokenCounter`, `options`。

```
閾値 = maxContextLength * thresholdRatio (= 0.6)

Step 0: countTokens(userPromptBuilder(元, folderTree)) <= 閾値 なら非圧縮で返却

Step 1: folderTree からファイル行を除去（stripFilesFromFolderTree を shared から流用）
        再判定、収まれば返却

Step 2 Phase 1:
  各ジョブログに対し fileKeepPercents をループで下げる
  最大ログを選択 → keepPercent を initial から step 刻みで減らす
  per-job 圧縮は compressJobLogByPercent（先頭/末尾 keepPercent% の行を残し中央省略）
  各反復で再判定

Step 2 Phase 2:
  全ログが minKeepPercent に達しても超過している場合
  keepLines ベースの半減ループ
  最大ログを選択 → keepLines を /2
  compressJobLogByLines で再圧縮

Best effort: Phase 2 を抜けても閾値超過なら、エラーを投げず現状を返す。
              ログには warning を出力して続行。
```

省略マーカー: `[aikata: N chars omitted from middle of job log. Use getJobLogDetail tool with jobId to view omitted portion]`

`stripFilesFromFolderTree` は `src/application/shared/diffCompression/FolderTreeStripper.ts` をそのまま import。`compressJobLogByPercent` / `compressJobLogByLines` は review の `compressFileDiff` / `compressFileDiffByLines` と同一ロジックをコピー（省略マーカー文言のみ変更）。将来 `BlockCompressor` として共通化する余地はあるが本 PBI ではスコープ外。

結果型: `{ compressed, compressedJobLogs, folderTreeStripped, strippedFolderTree, omittedJobLogs, compressedJobIds }`

### 5.3 `ArtifactArchiveReader` と `ArtifactCacheManager`

- `ArtifactArchiveReader`: `yauzl` ベースの pure JS zip パーサー。`listEntries(zipPath)` で Central Directory から全エントリ列挙、`readFile(zipPath, innerPath, { maxBytes })` でストリーム先頭取り出し。
- `ArtifactCacheManager`: temp ディレクトリ作成、`downloadArtifactArchive` の呼び出し、ディスク上限チェック、クリーンアップ。review の `CloneManager` と並列の存在。

環境変数（後述）で 1 ジョブ zip 上限・合計ディスク上限・1 ファイル最大バイトを制御。

## 6. Mastra 層

### 6.1 `pipelineAnalysisAgent`

- System prompt は `buildInstructions(context)` で動的構築
- ReAct フレームワーク（Reason → Act → Observe → Record）
- Workspace tools（review の `createWorkspaceFromContext` を流用）
- Memory: `lastMessages: 1000`
- Model: `context.aiModelName` + `openaiReasoningEffort`

System prompt に含まれるセクション:
1. Role definition
2. Mission（`resultFilePath` を完成させる）
3. User の `additionalInstructions`（非 null 時のみ最優先として挿入）
4. Report Structure: `OVERALL_REPORT_TEMPLATE` を提示
5. Per-Job Block Format: `jobReportFormat`（ユーザ指定 or デフォルト）を提示
6. Rules for Job Blocks: hint の扱い（列挙型 hint は必ず列挙値から選ぶ）
7. Target Jobs 一覧
8. ReAct Framework 説明
9. Quality Rules（成功でも疑うこと、citation の徹底、捏造禁止）
10. Tool catalog（条件付き。`omittedJobLogs.size > 0` なら `getJobLogDetail`、`hasImages` なら `readImage` を記載）
11. Compression Notes（条件付き。`omittedJobLogs.size > 0` または `folderTreeStripped` 時のみ）
12. Writing Constraints（`commentLanguage` 使用、引用短縮、コードブロックで全体を囲まない）
13. Finishing instructions

### 6.2 `reportCompletenessJudgeAgent`

- 役割: レポートが (a) 圧縮済みパイプラインコンテキスト、(b) 全体骨組み、(c) `jobReportFormat`、(d) `additionalInstructions`、(e) 対象ジョブ一覧 に照らして完成しているかを JSON 判定
- 出力スキーマ（zod）:
  ```ts
  {
    isComplete: boolean;
    missingItems: Array<{ jobId: number; jobName: string; reason: string }>;
    formatDeviations: string[];
  }
  ```
- Tools なし、構造化出力のみ
- 判定ルールの一般化: `jobReportFormat` 内の各 `<...>` hint が埋まっているか、列挙型 hint の値が列挙値のいずれかに一致するか、対象ジョブが全て網羅されているか

### 6.3 `pipelineReportSummarizationAgent`

review の `summarizationAgent` と同じパターン。コンテキスト長エラー発生時に会話履歴を要約し、どの対象ジョブまで分析済みか・どのツール呼び出しで何が判明したか・収集済み evidence 断片・未完了調査項目を保持する。

### 6.4 Tools

1. **`writeReport({ content })`**: `resultFilePath` にロック付き全文書き込み。lock は `mkdir` ベース（review のパターン流用）。
2. **`patchReport({ oldString, newString, replaceAll? })`**: `resultFilePath` の部分置換。`oldString` が一意でない場合はエラーメッセージ返却（例外は投げず Agent がリトライできる形）。
3. **`getReport()`**: `resultFilePath` の現在内容を返却。
4. **`getJobLogDetail({ jobId })`**: `RequestContext.omittedJobLogs.get(jobId)` を返却。無ければ「このジョブは圧縮されていない」旨を返す。条件付き登録（`omittedJobLogs.size > 0` 時のみ）。
5. **`getArtifactContent({ jobId, artifactPath })`**:
   - `ArtifactCacheManager.getZipPath(jobId)` + `ArtifactArchiveReader.readFile(...)` でキャッシュ zip から取得
   - MIME 判定: 画像（PNG/JPEG/GIF/WebP）→ review の `readImage` と同一メカニズムで `pendingImages` に積む → `prepareStep` で `FileUIPart` として挿入
   - テキスト判定（UTF-8 decodability）→ `{ kind: 'text', content, truncated }`
   - バイナリ（画像以外）→ `{ kind: 'unsupported', mimeType, size, reason }`
   - サイズ超過時は `maxBytes` まで切る（`truncated: true`）
   - エラー時は `{ kind: 'error', reason }`
6. **Workspace tools**: review の `createWorkspaceFromContext()` 出力（fileSystem 読み取り + local sandbox + skills）

`readImage` tool は review との共通部分（`pendingImages` key / message prefix の定数）を shared に切り出して両機能で import する。review の挙動を変えない最小限の refactor に限定。

### 6.5 Workflow: `pipelineAnalysisWorkflow`

入力スキーマ:
```
userId, projectId, pipelineId, selfJobId,
targetJobs: Job[],
jobLogsCompressed: Map<jobId, text>,
omittedJobLogs: Map<jobId, text>,
artifactTrees: ArtifactTree[],
folderTree: string,
folderTreeStripped: boolean,
pipelineMeta: Pipeline,
overallTemplate, jobReportFormat, additionalInstructions, commentLanguage,
skillsPaths, resultFilePath, maxCompletenessRetries
```

出力スキーマ: `{ reportContent, completenessVerified, completenessRetries }`

ステップ:
- **`executeAnalysisStep`**: `resultFilePath` にテンプレートを書き込み → `pipelineAnalysisAgent.stream(userPrompt, { memory, toolsets, prepareStep })` → context length エラー検知で `contextLengthRecovery` 呼び出し（最大 3 回）
- **`verifyCompletenessStep`**: `resultFilePath` を読み → `reportCompletenessJudgeAgent.generate(...)` → `isComplete=true` なら完了 / `false` なら不足項目をフィードバックとして `pipelineAnalysisAgent` の同一スレッドに投入して再実行 → 再度 verify。`maxCompletenessRetries` 到達で警告ログを出して完了

### 6.6 Request Context

- `PipelineAnalysisAgentRequestContext` = `WorkflowRequestContext` (userId/projectId/aiConfig/projectDir 等) +
  `targetJobs`, `jobReportFormat`, `additionalInstructions`, `commentLanguage`, `overallTemplate`,
  `resultFilePath`, `skillsPaths`, `folderTree`, `folderTreeStripped`, `omittedJobLogs`,
  `artifactCachePaths`, `hasImages`, `pendingImages`
- `ReportCompletenessJudgeAgentRequestContext` = userId/projectId/aiConfig + 判定に必要なテキスト群
- `PipelineReportSummarizationAgentRequestContext` = 要約に必要な最小限

## 7. Infrastructure 層

### 7.1 `PipelineGateway` ポート

`src/application/shared/port/gateway/PipelineGateway.ts`:

```ts
export interface PipelineGateway {
  getPipeline(projectId: number, pipelineId: number): Promise<Pipeline>;
  getJobs(projectId: number, pipelineId: number, options: { includeRetried: boolean }): Promise<Job[]>;
  getJobTrace(projectId: number, jobId: number): Promise<string>;
  downloadArtifactArchive(
    projectId: number,
    jobId: number,
    destPath: string,
    options: { maxBytes: number },
  ): Promise<{ bytesWritten: number; truncated: boolean }>;
}
```

GitLab v16 前提のため `getArtifactTree` / `getArtifactFile` はポートから除外。zip ダウンロード経由でファイル一覧と個別取得を行う。

### 7.2 `GitLabPipelineGateway`

- `getPipeline` → `GET /projects/:id/pipelines/:pipeline_id`
- `getJobs` → `GET /projects/:id/pipelines/:pipeline_id/jobs?include_retried=false`（`per_page=100` ページネーション）
- `getJobTrace` → `GET /projects/:id/jobs/:job_id/trace`
- `downloadArtifactArchive` → `GET /projects/:id/jobs/:job_id/artifacts`（先頭 `maxBytes` だけ保存）

認証: `PRIVATE-TOKEN: $AIKATA_PR_GITLAB_TOKEN`（review と共通）
ログ: `getLogger()` で自動バインディング

### 7.3 `PipelineReportApiClient`

`ReviewApiClient` と同型。`POST /api/v1/pipeline-report` に対して SSE で進捗受領。進捗イベント:
- `{ type: 'phase', phase: 'fetching'|'compressing'|'analyzing'|'verifying'|'done' }`
- `{ type: 'log', level, message }`
- `{ type: 'retry', reason, retryCount }`
- `{ type: 'result', reportContent, completenessVerified, completenessRetries }`
- `{ type: 'error', message, classification }`

### 7.4 `MastraPipelineAnalysisWorkflowRunner`

`PipelineAnalysisWorkflowRunner` ポートの Mastra 実装。`runWithLogContext` により下流の `getLogger()` にリクエスト単位バインディングを伝播。

## 8. Presentation 層

### 8.1 CLI

`pipelineReportCliModule = { name: 'pipeline-report', description, run(args) }` を `src/cli/pipeline-report/index.ts` で定義し、`src/cli/dispatch.ts` の `defaultFeatures` に追加。

CLI オプションと環境変数マッピング:

| CLI | 環境変数 | デフォルト | 内容 |
| --- | --- | --- | --- |
| `--user-id` | `USER_ID` | 必須 | ログ用 user ID |
| `--project-id` | `GITLAB_PROJECT_ID` | 必須 | GitLab project ID |
| `--pipeline-id` | `GITLAB_PIPELINE_ID` / `CI_PIPELINE_ID` | 必須 | 対象 pipeline ID |
| `--self-job-id` | `GITLAB_SELF_JOB_ID` / `CI_JOB_ID` | なし | 自ジョブ（除外） |
| `--pipeline-report-settings` | `PIPELINE_REPORT_SETTINGS_PATH` | なし | 設定 JSON パス |
| `--skills` | `SKILLS_PATH` | なし | Mastra workspace skills |
| `--aikata-pr-gitlab-token` | `AIKATA_PR_GITLAB_TOKEN` | 必須 | GitLab token |
| `--ai-model-name` | `AI_MODEL_NAME` | `openai/o4-mini` | AI モデル |
| `--log-level` | `AIKATA_LOG_LEVEL` | `info` | ログレベル |
| `--comment-language` | `COMMENT_LANGUAGE` | `Japanese` | レポート言語 |
| `--aikata-api-url` | `AIKATA_API_URL` | なし | API モード URL |
| `--result-file` | `PIPELINE_REPORT_RESULT_FILE` | `./aikata-pipeline-report.md` | レポート出力パス |
| `--max-completeness-retries` | `PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES` | `3` | 完成判定ループ上限 |

環境変数のみ:

| 変数 | 内容 |
| --- | --- |
| `AI_API_KEY` | AI API キー（ローカルモード時のみ） |
| `AI_API_ENDPOINT_URL` | AI API エンドポイント |
| `AIKATA_JWT` | GitLab `id_tokens` 自動生成 JWT |
| `MAX_CONTEXT_LENGTH` | review と共通、圧縮閾値用 |
| `TREE_MAX_DEPTH` | review と共通 |
| `PIPELINE_REPORT_MAX_ARTIFACT_ZIP_MB` | 1 ジョブ zip 上限（デフォルト 50） |
| `PIPELINE_REPORT_TOTAL_ARTIFACT_DISK_MB` | 全 zip 合計上限（デフォルト 500） |
| `PIPELINE_REPORT_MAX_ARTIFACT_FILE_BYTES` | `getArtifactContent` の最大バイト（デフォルト 2 MiB） |

### 8.2 設定 JSON

```json
{
  "jobReportFormat": "### ジョブ #<jobId> ...",
  "additionalInstructions": "セキュリティスキャンジョブの警告は厳しく扱うこと。",
  "includeJobPatterns": ["^test:", "^build"],
  "excludeJobPatterns": ["\\.dev$"]
}
```

全 optional。`jobReportFormat` は「ジョブ 1 件分のレポートブロックのフォーマット」のみ。全体骨組みは固定。パーサー: `src/application/shared/parser/parsePipelineReportSettings.ts`。RegExp コンパイル失敗時は `PipelineReportSettingsParseError`。

### 8.3 API サーバー

`pipelineReportApiModule = { name: 'pipeline-report', register(app) }` を `src/presentation/api/pipeline-report/index.ts` で定義し、`src/server.ts` の `apiFeatures` に追加。

- ルート: `POST /api/v1/pipeline-report`
- ミドルウェア: `requestIdMiddleware` + JWT 認証 + deps 注入
- ハンドラ: JWT クレーム抽出 → `runWithLogContext` → `CloneManager.clone` → `PipelineAnalysisService.analyze` → SSE で進捗 + 最終レポート → finally で cleanup

リクエストボディ (zod):
```ts
{
  userId: string;
  projectId: number;
  pipelineId: number;
  selfJobId: number | null;
  settings: PipelineReportSettingsDto;
  commentLanguage: string;
  aiModelName: string;
  maxContextLength: number | null;
  maxCompletenessRetries: number;
  skillsRelPaths: string[];
}
```

### 8.4 CI テンプレート

`.ci-template/pipelines/pipeline-report/template.yml`（Docker 方式）:

```yaml
aikata-pipeline-report:
  stage: .post
  image: ${AIKATA_IMAGE}:${AIKATA_IMAGE_TAG}
  id_tokens:
    AIKATA_JWT:
      aud: "${CI_SERVER_URL}"
  rules:
    - if: $AIKATA_PR_DISABLED == "true"
      when: never
    - when: always
  script:
    - node /app/dist/index.js pipeline-report
      --user-id "$GITLAB_USER_LOGIN"
      --project-id "$CI_PROJECT_ID"
      --pipeline-id "$CI_PIPELINE_ID"
      --self-job-id "$CI_JOB_ID"
  artifacts:
    when: always
    paths:
      - aikata-pipeline-report.md
    expire_in: 1 week
```

`.ci-template/pipelines/pipeline-report/template-npx.yml` は npx 方式で同等内容。既存の `.ci-template/pipelines/template.yml` ファサードは pipeline-report をデフォルト include しない（影響範囲が大きいため、ユーザが明示的に include する運用）。

`.ci-template/variable/pipeline-report.yml`:
```yaml
variables:
  GITLAB_PIPELINE_ID: $CI_PIPELINE_ID
  GITLAB_SELF_JOB_ID: $CI_JOB_ID
  PIPELINE_REPORT_SETTINGS_PATH: ""
  PIPELINE_REPORT_RESULT_FILE: "./aikata-pipeline-report.md"
  PIPELINE_REPORT_MAX_ARTIFACT_ZIP_MB: "50"
  PIPELINE_REPORT_TOTAL_ARTIFACT_DISK_MB: "500"
  PIPELINE_REPORT_MAX_ARTIFACT_FILE_BYTES: "2097152"
  PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES: "3"
```

`.ci-template/variable/variables.yml` から include する。

## 9. エラー処理

新規エラークラス:
- `PipelineReportArtifactArchiveError`: zip ダウンロード / パース失敗
- `PipelineReportSettingsParseError`: 設定ファイル JSON/RegExp パース失敗

圧縮経路では独自エラーを投げず、best-effort で返却する。抜けきれず AI API で context length エラーが発生した場合は `contextLengthRecovery` が要約で対応する。既存の `classifyError()` を拡張して上記 2 エラー種別を識別可能にする。

CLI 終了コード:
- ツール自体のエラー（GitLab API / AI API / Mastra / zip 処理）: `exit(1)` + stderr に時刻・userId・詳細（英語）
- 完成判定の上限到達: `exit(0)` + stderr に警告（助言的挙動、ジョブは成功）
- 通常完了: `exit(0)` + stdout にレポート全文

## 10. テスト戦略

各 SUT の近くに `__tests__/` を配置。vitest。カバレッジ目標: 条件カバレッジ 80% 以上。

**ドメイン層**: `PipelineReportSettings.filterJobs` の組合せ、`JobStatus` 純粋関数、エンティティ不変条件。

**アプリケーション層**:
- `PipelineAnalysisService` の振る舞いテスト（古典派）: 正常系、GitLab API 失敗、zip 失敗、workflow エラー、圧縮 best-effort 到達。fake 依存を使用
- `JobLogCompressor`: review `DiffCompressor.test.ts` と同型シナリオ（閾値以下 / Step 1 / Phase 1 / Phase 2 / best effort）
- `ArtifactArchiveReader`: 実 zip ファイル対象
- `parsePipelineReportSettings`: 正常系 + RegExp コンパイル失敗

**Mastra 層**:
- tools の単体: `writeReport`/`patchReport`/`getReport`/`getJobLogDetail`/`getArtifactContent`
- `buildInstructions` の条件分岐網羅
- agent と workflow の軽量テスト（fake LLM）
- `contextLengthRecovery` のシナリオ

**インフラ層**:
- `GitLabPipelineGateway`: HTTP モックで v16 API コール検証
- `PipelineReportApiClient`: SSE パース（MSW 等）
- `MastraPipelineAnalysisWorkflowRunner`: 薄層差分テスト

**CLI 層**: `parsePipelineReportArgs`, `run()` 正常系・異常系、ローカル/API モード切替

**プレゼンテーション層**: `pipelineReportRoute` の JWT + SSE、`featureRegistration.test.ts` に pipeline-report モジュール登録を追加

**パラメータ伝播テスト**: `src/__tests__/pipelineReportParameterPropagation.test.ts` を新設。CLI → Command → Service → Workflow → Agent RequestContext の鎖で `jobReportFormat`, `additionalInstructions`, `includeJobPatterns`, `commentLanguage`, `maxContextLength` が伝播することを検証。

## 11. ドキュメント

**新規**:
- `docs/domain/pipeline-report/entity.md`
- `docs/domain/pipeline-report/business_rule.md`（ジョブフィルタ / 圧縮順序 / 完成判定ループ / AI 総合評価ラベル / 固定レポート骨組み / GitLab v16 制約）
- `docs/domain/pipeline-report/usecase.md`
- `docs/domain/pipeline-report/glossary.md`
- `docs/archtecture/pipeline-report/overallflow_concept.md`

**更新**:
- `docs/archtecture/tech.md`（pipeline-report 機能追加、CLI サブコマンド、API エンドポイント、環境変数）
- `docs/archtecture/folder_structure.md`
- `docs/archtecture/feature-extension.md`（pipeline-report を実例リンクとして追記）
- `docs/config/env_val.md`（`PIPELINE_REPORT_*` 変数）
- `docs/domain/glossary.md`（pipeline-report への参照追加）
- `AGENTS.md` / `CLAUDE.md`（CLI サブコマンドに pipeline-report を追記）
- `.env.example`（新規環境変数デフォルト）
- `PBI.md`（ID:1 のステータスを `in progress` に変更）

## 12. 依存関係追加

- `yauzl`（pure JS zip ストリーミングパーサー、Apache-2.0）を `package.json` に追加

その他既存の `pino` / `hono` / `zod` / `pino-std-serializers` / Mastra 等は変更なし。

## 13. スコープ外（将来）

- pipeline-report と review の結果の相互参照
- quality gate 的な「失敗ジョブ数がしきい値超過ならジョブを失敗させる」オプション
- 複数パイプラインの横断分析
- 全体レポート骨組みのユーザカスタマイズ
- `BlockCompressor` として review / pipeline-report の圧縮ロジックを共通化する refactor

## 14. 未解決・要確認事項

- GitLab v15 以前での artifacts zip ダウンロード API の挙動は未検証（v16+ のみを保証対象とする）
- `yauzl` 依存追加は社内のネットワーク制約・ライセンスチェック（Apache-2.0）に抵触しないか最終確認が必要
- 大量ジョブ（数百）を含むパイプラインでの実運用時の性能特性は実装後にベンチマーク必要

---

以上。本設計書は実装計画書 (`writing-plans` 出力予定) の入力となる。
