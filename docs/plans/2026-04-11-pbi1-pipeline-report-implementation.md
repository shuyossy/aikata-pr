# PBI1 pipeline-report 機能 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** GitLab CI/CD パイプラインの全ジョブを AI で解析し、単一の Markdown レポートを artifacts と標準出力に残す新機能 `pipeline-report` を、クリーンアーキテクチャ準拠で実装する。

**Architecture:** review 機能と同じ「マルチ機能ホスト」パターンに従い、各レイヤーに `pipeline-report/` サブフォルダを新設。Application 層で GitLab API 経由のデータ収集と圧縮を行い、Mastra 層で単一 Agent による分析・完成判定ループを実装。CLI はサブコマンド方式、API は `POST /api/v1/pipeline-report` (SSE)。

**Tech Stack:** TypeScript / Mastra / Hono / yauzl (新規) / Pino / Vitest / GitLab CI

**設計書:** `docs/plans/2026-04-11-pbi1-pipeline-report-design.md`

---

## 前提・共通ルール

### 各タスク完了時の検証コマンド

```bash
npm run test       # 全テストグリーン
npm run lint       # ESLint クリア
npm run build:cli  # バンドル成功
```

**3つ全てグリーンでなければ次タスクに進まない。**

### コミットメッセージ規約

- commitlint (conventional-commits) を使う
- subject は **小文字開始**、`type: ` プレフィックス必須
- 日本語 OK
- 例: `feat: pipeline-reportのドメインエンティティを追加`

### TDD 原則

- **Red**: まず失敗するテストを書く
- **Green**: 最小実装でテストを通す
- **Refactor**: 重複・可読性を改善
- タスクごとに 1 コミット以上（Red→Green→Refactor が 1 コミットでも可）

### 既存資源の徹底再利用

- 新規実装前に `src/domain/review/`, `src/application/review/`, `src/mastra/review/` の**対応物を必ず読む**
- 以下は基本的に再利用する:
  - `src/application/shared/diffCompression/FolderTreeStripper.ts` (変更せず import)
  - `src/application/shared/parser/parseReviewSettings.ts` のパターン
  - `src/application/shared/port/gateway/*` の命名・型パターン
  - `src/application/shared/port/workflow/ReviewWorkflowRunner.ts` の構造
  - `src/application/shared/port/rateLimiter/RateLimiterPort.ts`
  - `src/application/shared/port/tokenCounter/TokenCounter.ts`
  - `src/application/shared/port/clone/*`
  - `src/application/shared/port/projectTree/*`
  - `src/infrastructure/adapter/httpClient/GitLabApiClient.ts`
  - `src/infrastructure/adapter/rateLimiter/RateLimiter.ts`
  - `src/infrastructure/adapter/clone/CloneManager.ts`
  - `src/lib/logger.ts` の `initializeLogger` / `runWithLogContext` / `getLogger`
  - `src/lib/errorClassifier.ts`
  - `src/mastra/review/workflows/steps/contextLengthRecovery.ts` の構造
  - `src/mastra/review/agents/reviewAgent.ts` の `buildInstructions` パターン
  - `src/mastra/review/tools/storeReviewResult.ts` の `mkdir` ベースのロック取得処理

### ファイルパスの ESM 拡張子

- TypeScript ファイル間の import は必ず `.js` 拡張子を付ける（ESM 規約）

### プロンプトは英語で記載する

- Agent の system prompt / user prompt は英語
- コードコメント・ドキュメントは日本語
- エラーメッセージは英語

### 変更の最小化原則

- 新規ファイルの作成 >> 既存ファイルの編集
- 既存ファイルを編集する場合は diff を最小限に
- review 機能の挙動は変えない。特に `src/mastra/review/` や `src/application/review/` は **import 追加以外の変更を避ける**（例外: 共通化のために必要最小限の tool を shared に移す場合のみ）

### シェル実行の禁則

- テストや実装コードで `child_process.exec` / `execSync` を使わない（本リポジトリは `src/utils/execFileNoThrow.ts` を安全な代替として提供している）
- zip テスト用のフィクスチャは **事前に用意した `.zip` ファイル**を `__tests__/fixtures/` にコミットして読み込む
- どうしてもプロセス実行が必要な場合は `execFileNoThrow` を使う

---

## Phase 0: ベースライン確認

### Task 0-1: 現在の状態確認

**Step 1: ブランチとステータス確認**

Run:
```bash
git status
git branch --show-current
```
Expected: `develop` ブランチ。ワーキングツリーは `PBI.md` のみ変更（既存）。

**Step 2: 初期テスト全通過を確認**

Run:
```bash
npm run test
npm run lint
npm run build:cli
```
Expected: 全てパス。（既存で失敗があれば名前をメモし、本 PBI の作業で同じ失敗のみが残ることを後で確認）。

**Step 3: 設計書を読み込む**

Read: `docs/plans/2026-04-11-pbi1-pipeline-report-design.md`

**Step 4: review 機能の対応物を読み込んで頭に入れる**

Read:
- `src/domain/review/checkItem/CheckItem.ts`
- `src/domain/review/reviewSettings/ReviewSettings.ts`
- `src/application/review/reviewExecution/ReviewExecutionService.ts`
- `src/application/shared/diffCompression/DiffCompressor.ts`
- `src/application/shared/diffCompression/FolderTreeStripper.ts`
- `src/mastra/review/agents/reviewAgent.ts`
- `src/mastra/review/workflows/reviewWorkflow.ts`
- `src/mastra/review/workflows/steps/contextLengthRecovery.ts`
- `src/mastra/review/tools/storeReviewResult.ts`
- `src/mastra/review/tools/getReviewResults.ts`
- `src/mastra/review/tools/getDiffDetail.ts`
- `src/mastra/review/tools/readImage.ts`
- `src/mastra/review/requestContext.ts`
- `src/mastra/index.ts`
- `src/cli/dispatch.ts`
- `src/cli/review/index.ts`
- `src/server.ts`
- `src/presentation/api/review/index.ts`
- `src/presentation/api/review/reviewRoute.ts`
- `src/presentation/api/review/reviewHandler.ts`
- `src/infrastructure/adapter/review/gateway/GitLabMrDiscussionGateway.ts`
- `src/infrastructure/adapter/review/apiClient/ReviewApiClient.ts`
- `src/infrastructure/adapter/review/workflow/MastraReviewWorkflowRunner.ts`

---

## Phase 1: ドメイン層（内側から外へ）

依存のない純粋クラスから作る。全て `src/domain/pipeline-report/` 配下。

### Task 1-1: Pipeline エンティティ

**Files:**
- Create: `src/domain/pipeline-report/pipeline/Pipeline.ts`
- Test: `src/domain/pipeline-report/pipeline/__tests__/Pipeline.test.ts`

**Step 1: 失敗するテストを書く**

テストは `Pipeline.of(params)` のファクトリを呼び、プロパティが readonly で露出することと、空 sha / 非正の projectId/pipelineId で例外になることを検証する。

**Step 2: 実行して失敗を確認**

Run: `npx vitest run src/domain/pipeline-report/pipeline/__tests__/Pipeline.test.ts`
Expected: FAIL (モジュールが存在しない)

**Step 3: 最小実装**

`src/domain/pipeline-report/pipeline/Pipeline.ts`:
```ts
/**
 * GitLab CI/CD パイプライン
 */
export type PipelineStatus =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled';

export interface PipelineParams {
  projectId: number;
  pipelineId: number;
  ref: string;
  sha: string;
  status: PipelineStatus;
  webUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export class Pipeline {
  private constructor(
    readonly projectId: number,
    readonly pipelineId: number,
    readonly ref: string,
    readonly sha: string,
    readonly status: PipelineStatus,
    readonly webUrl: string,
    readonly createdAt: Date,
    readonly updatedAt: Date,
  ) {}

  static of(params: PipelineParams): Pipeline {
    if (params.projectId <= 0) {
      throw new Error(`projectId must be positive, got ${params.projectId}`);
    }
    if (params.pipelineId <= 0) {
      throw new Error(`pipelineId must be positive, got ${params.pipelineId}`);
    }
    if (!params.sha) {
      throw new Error('sha must not be empty');
    }
    return new Pipeline(
      params.projectId,
      params.pipelineId,
      params.ref,
      params.sha,
      params.status,
      params.webUrl,
      params.createdAt,
      params.updatedAt,
    );
  }
}
```

**Step 4: テスト通過を確認**

Run: `npx vitest run src/domain/pipeline-report/pipeline/__tests__/Pipeline.test.ts`
Expected: PASS

**Step 5: コミット**

```bash
git add src/domain/pipeline-report/pipeline/
git commit -m "feat: pipeline-reportのpipelineエンティティを追加"
```

### Task 1-2: JobStatus

**Files:**
- Create: `src/domain/pipeline-report/job/JobStatus.ts`
- Test: `src/domain/pipeline-report/job/__tests__/JobStatus.test.ts`

**Step 1: 失敗するテスト**

`isTerminatedJobStatus` / `isSuccessfulJobStatus` の判定を検証。`success`/`failed`/`canceled`/`skipped` が terminated、`running`/`pending`/`created` が not-terminated、`success` のみが successful であることをアサート。

**Step 2-4: 赤→緑**

`src/domain/pipeline-report/job/JobStatus.ts`:
```ts
/**
 * GitLab CI/CD ジョブのステータス
 * @see https://docs.gitlab.com/ee/api/jobs.html
 */
export type JobStatus =
  | 'created'
  | 'pending'
  | 'running'
  | 'failed'
  | 'success'
  | 'canceled'
  | 'skipped'
  | 'waiting_for_resource'
  | 'manual'
  | 'preparing'
  | 'scheduled';

const TERMINATED: ReadonlySet<JobStatus> = new Set([
  'success',
  'failed',
  'canceled',
  'skipped',
]);

export function isTerminatedJobStatus(status: JobStatus): boolean {
  return TERMINATED.has(status);
}

export function isSuccessfulJobStatus(status: JobStatus): boolean {
  return status === 'success';
}
```

Run: `npx vitest run src/domain/pipeline-report/job/__tests__/JobStatus.test.ts`
Expected: PASS

**Step 5: コミット**

```bash
git add src/domain/pipeline-report/job/JobStatus.ts src/domain/pipeline-report/job/__tests__/JobStatus.test.ts
git commit -m "feat: pipeline-reportのjobStatus型と判定関数を追加"
```

### Task 1-3: Job エンティティ

**Files:**
- Create: `src/domain/pipeline-report/job/Job.ts`
- Test: `src/domain/pipeline-report/job/__tests__/Job.test.ts`

**Step 1: テスト**

`Job.of(params)` が全フィールドを readonly で露出すること、`startedAt`/`finishedAt`/`duration`/`failureReason` が null 許容であること、非正の id を拒否することを検証。

**Step 2-4:**

`src/domain/pipeline-report/job/Job.ts`:
```ts
import type { JobStatus } from './JobStatus.js';

export interface JobParams {
  id: number;
  name: string;
  stage: string;
  status: JobStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  duration: number | null;
  webUrl: string;
  failureReason: string | null;
  hasArtifacts: boolean;
  artifactsSize: number;
}

export class Job {
  private constructor(
    readonly id: number,
    readonly name: string,
    readonly stage: string,
    readonly status: JobStatus,
    readonly startedAt: Date | null,
    readonly finishedAt: Date | null,
    readonly duration: number | null,
    readonly webUrl: string,
    readonly failureReason: string | null,
    readonly hasArtifacts: boolean,
    readonly artifactsSize: number,
  ) {}

  static of(params: JobParams): Job {
    if (params.id <= 0) {
      throw new Error(`id must be positive, got ${params.id}`);
    }
    return new Job(
      params.id,
      params.name,
      params.stage,
      params.status,
      params.startedAt,
      params.finishedAt,
      params.duration,
      params.webUrl,
      params.failureReason,
      params.hasArtifacts,
      params.artifactsSize,
    );
  }
}
```

Run: `npx vitest run src/domain/pipeline-report/job/__tests__/Job.test.ts`

**Step 5: コミット**

```bash
git add src/domain/pipeline-report/job/
git commit -m "feat: pipeline-reportのjobエンティティを追加"
```

### Task 1-4: JobLog 値オブジェクト

**Files:**
- Create: `src/domain/pipeline-report/job/JobLog.ts`
- Test: `src/domain/pipeline-report/job/__tests__/JobLog.test.ts`

**Step 1: テスト**

`JobLog.full(jobId, text)` と `JobLog.compressed({...})` の両ファクトリを検証。`omittedRange` が full では null、compressed では指定値であることをアサート。

**Step 2-4:**

`src/domain/pipeline-report/job/JobLog.ts`:
```ts
export interface OmittedRange {
  startChar: number;
  endChar: number;
}

export class JobLog {
  private constructor(
    readonly jobId: number,
    readonly compressedText: string,
    readonly omittedRange: OmittedRange | null,
    readonly totalChars: number,
  ) {}

  static full(jobId: number, text: string): JobLog {
    return new JobLog(jobId, text, null, text.length);
  }

  static compressed(params: {
    jobId: number;
    compressedText: string;
    omittedRange: OmittedRange;
    totalChars: number;
  }): JobLog {
    return new JobLog(
      params.jobId,
      params.compressedText,
      params.omittedRange,
      params.totalChars,
    );
  }
}
```

**Step 5: コミット**

```bash
git add src/domain/pipeline-report/job/JobLog.ts src/domain/pipeline-report/job/__tests__/JobLog.test.ts
git commit -m "feat: pipeline-reportのjobLog値オブジェクトを追加"
```

### Task 1-5: ArtifactEntry / ArtifactTree

**Files:**
- Create: `src/domain/pipeline-report/artifact/ArtifactEntry.ts`
- Create: `src/domain/pipeline-report/artifact/ArtifactTree.ts`
- Test: `src/domain/pipeline-report/artifact/__tests__/ArtifactTree.test.ts`

**Step 1: テスト**

`ArtifactTree.of({ jobId, jobName, entries })` が entries を保持し、`filePaths()` がファイルのパスだけを返すこと、`ArtifactTree.empty(jobId, jobName)` が空配列を返すことを検証。

**Step 2-4:**

`src/domain/pipeline-report/artifact/ArtifactEntry.ts`:
```ts
export interface ArtifactEntry {
  path: string;
  type: 'file' | 'tree';
  size: number;
  mode: string;
}
```

`src/domain/pipeline-report/artifact/ArtifactTree.ts`:
```ts
import type { ArtifactEntry } from './ArtifactEntry.js';

export class ArtifactTree {
  private constructor(
    readonly jobId: number,
    readonly jobName: string,
    readonly entries: readonly ArtifactEntry[],
  ) {}

  static of(params: {
    jobId: number;
    jobName: string;
    entries: ArtifactEntry[];
  }): ArtifactTree {
    return new ArtifactTree(params.jobId, params.jobName, [...params.entries]);
  }

  static empty(jobId: number, jobName: string): ArtifactTree {
    return new ArtifactTree(jobId, jobName, []);
  }

  filePaths(): string[] {
    return this.entries.filter((e) => e.type === 'file').map((e) => e.path);
  }
}
```

**Step 5: コミット**

```bash
git add src/domain/pipeline-report/artifact/
git commit -m "feat: pipeline-reportのartifactエンティティを追加"
```

### Task 1-6: PipelineReportSettings (filterJobs ビジネスルール)

**Files:**
- Create: `src/domain/pipeline-report/pipelineReportSettings/PipelineReportSettings.ts`
- Test: `src/domain/pipeline-report/pipelineReportSettings/__tests__/PipelineReportSettings.test.ts`

**Step 1: 失敗するテスト**

`filterJobs(jobs, selfJobId)` のビジネスルールを網羅:
1. `selfJobId` 除外のみ
2. パターンなし・selfJobId null → 全通過
3. `includeJobPatterns` 適用
4. `excludeJobPatterns` 適用
5. self + include + exclude の組み合わせ

**Step 2-4:**

`src/domain/pipeline-report/pipelineReportSettings/PipelineReportSettings.ts`:
```ts
import type { Job } from '../job/Job.js';

export class PipelineReportSettings {
  constructor(
    /** ジョブ 1 件分のレポートブロックのフォーマット (= review の commentFormat と同じ粒度) */
    readonly jobReportFormat: string,
    readonly additionalInstructions: string | null,
    readonly includeJobPatterns: readonly RegExp[],
    readonly excludeJobPatterns: readonly RegExp[],
  ) {}

  /**
   * 分析対象ジョブの選定:
   * 1. selfJobId と一致するジョブを除外
   * 2. includeJobPatterns が空でない場合、いずれかにマッチするもののみ通過
   * 3. excludeJobPatterns のいずれかにマッチするものを除外
   */
  filterJobs(jobs: readonly Job[], selfJobId: number | null): Job[] {
    return jobs.filter((job) => {
      if (selfJobId !== null && job.id === selfJobId) return false;
      if (this.includeJobPatterns.length > 0) {
        const included = this.includeJobPatterns.some((re) => re.test(job.name));
        if (!included) return false;
      }
      if (this.excludeJobPatterns.some((re) => re.test(job.name))) return false;
      return true;
    });
  }
}
```

Run: `npx vitest run src/domain/pipeline-report/pipelineReportSettings/`

**Step 5: コミット**

```bash
git add src/domain/pipeline-report/pipelineReportSettings/
git commit -m "feat: pipeline-reportのsettingsとfilterJobsビジネスルールを追加"
```

### Task 1-7: AnalysisReport

**Files:**
- Create: `src/domain/pipeline-report/analysisReport/AnalysisReport.ts`
- Test: `src/domain/pipeline-report/analysisReport/__tests__/AnalysisReport.test.ts`

**Step 1: テスト**

`AnalysisReport.of(content)` が content を readonly で露出し、`isEmpty()` が空白のみの場合に true を返すことを検証。

**Step 2-4:**

```ts
export class AnalysisReport {
  private constructor(readonly content: string) {}

  static of(content: string): AnalysisReport {
    return new AnalysisReport(content);
  }

  isEmpty(): boolean {
    return this.content.trim().length === 0;
  }
}
```

**Step 5: コミット**

```bash
git add src/domain/pipeline-report/analysisReport/
git commit -m "feat: pipeline-reportのanalysisReport値オブジェクトを追加"
```

### Task 1-8: ドメイン層全体テスト確認

**Step 1: ドメイン層のテストを全部走らせる**

Run: `npx vitest run src/domain/pipeline-report/`
Expected: 全テストグリーン

**Step 2: lint + build**

Run: `npm run lint && npm run build:cli`
Expected: 成功

---

## Phase 2: Application 層 — 共有ポートとパーサー

### Task 2-1: PipelineGateway ポート（interface のみ）

**Files:**
- Create: `src/application/shared/port/gateway/PipelineGateway.ts`

**Step 1: 実装（interface のみなのでテストは不要）**

```ts
import type { Pipeline } from '../../../../domain/pipeline-report/pipeline/Pipeline.js';
import type { Job } from '../../../../domain/pipeline-report/job/Job.js';

export interface PipelineGateway {
  getPipeline(projectId: number, pipelineId: number): Promise<Pipeline>;

  getJobs(
    projectId: number,
    pipelineId: number,
    options: { includeRetried: boolean },
  ): Promise<Job[]>;

  getJobTrace(projectId: number, jobId: number): Promise<string>;

  /**
   * artifacts zip を destPath にダウンロードする。
   * maxBytes を超えた分は切り捨て (truncated=true) とする。
   */
  downloadArtifactArchive(
    projectId: number,
    jobId: number,
    destPath: string,
    options: { maxBytes: number },
  ): Promise<{ bytesWritten: number; truncated: boolean }>;
}
```

**Step 2: コンパイル確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

**Step 3: コミット**

```bash
git add src/application/shared/port/gateway/PipelineGateway.ts
git commit -m "feat: pipelineGatewayポートインターフェースを追加"
```

### Task 2-2: PipelineAnalysisWorkflowRunner ポート

**Files:**
- Create: `src/application/shared/port/workflow/PipelineAnalysisWorkflowRunner.ts`

**Step 1: 実装**

review の `ReviewWorkflowRunner.ts` を参考に、以下を作成:

```ts
import type { Pipeline } from '../../../../domain/pipeline-report/pipeline/Pipeline.js';
import type { Job } from '../../../../domain/pipeline-report/job/Job.js';
import type { ArtifactTree } from '../../../../domain/pipeline-report/artifact/ArtifactTree.js';

export interface PipelineAnalysisWorkflowParams {
  userId: string;
  projectId: number;
  pipelineMeta: Pipeline;
  targetJobs: Job[];
  jobLogsCompressed: Map<number, string>;
  omittedJobLogs: Map<number, string>;
  artifactTrees: ArtifactTree[];
  folderTree: string;
  folderTreeStripped: boolean;
  overallTemplate: string;
  jobReportFormat: string;
  additionalInstructions: string | null;
  commentLanguage: string;
  skillsPaths: string[];
  resultFilePath: string;
  projectDir: string;
  artifactCachePaths: Map<number, string | null>;
  maxCompletenessRetries: number;
  aiConfig: {
    apiKey: string;
    endpointUrl: string;
    modelName: string;
    reasoningEffort: 'low' | 'medium' | 'high' | null;
  };
  onProgress?: (event: PipelineAnalysisProgressEvent) => void;
}

export type PipelineAnalysisProgressEvent =
  | { type: 'phase'; phase: 'analyzing' | 'verifying' | 'recovery' | 'done' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'retry'; reason: string; retryCount: number };

export interface PipelineAnalysisWorkflowResult {
  reportContent: string;
  completenessVerified: boolean;
  completenessRetries: number;
}

export interface PipelineAnalysisWorkflowRunner {
  run(params: PipelineAnalysisWorkflowParams): Promise<PipelineAnalysisWorkflowResult>;
}
```

**Step 2: tsc 確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

**Step 3: コミット**

```bash
git add src/application/shared/port/workflow/PipelineAnalysisWorkflowRunner.ts
git commit -m "feat: pipelineAnalysisWorkflowRunnerポートを追加"
```

### Task 2-3: defaultReportFormat + parsePipelineReportSettings + エラー型

**Files:**
- Create: `src/application/pipeline-report/pipelineAnalysis/defaultReportFormat.ts`
- Create: `src/application/shared/parser/parsePipelineReportSettings.ts`
- Create: `src/application/shared/parser/PipelineReportSettingsParseError.ts`
- Test: `src/application/shared/parser/__tests__/parsePipelineReportSettings.test.ts`

**Step 1: 失敗するテスト**

テスト内容（テスト関数の概要）:
1. 全フィールド指定した JSON をパース → 各フィールドが正しく反映
2. 空オブジェクト `{}` → 全デフォルト（`jobReportFormat=DEFAULT_JOB_REPORT_FORMAT` 等）
3. 不正 JSON 文字列 → `PipelineReportSettingsParseError` が投げられる
4. 不正な RegExp パターン（例: `'[unclosed'`）→ `PipelineReportSettingsParseError`
5. `includeJobPatterns` が配列でない → `PipelineReportSettingsParseError`

**Step 2: 先に defaultReportFormat を実装**

`src/application/pipeline-report/pipelineAnalysis/defaultReportFormat.ts`:
```ts
/**
 * 全体レポートの骨組み（固定・ユーザカスタマイズ不可）。
 * {{job-sections}} 部分に各ジョブのレポートブロックが並ぶ。
 */
export const OVERALL_REPORT_TEMPLATE = `# パイプライン分析レポート

**パイプライン:** [#{{pipelineId}}]({{pipelineWebUrl}}) — \`{{ref}}\` @ \`{{sha}}\`
**ステータス:** {{pipelineStatus}}
**分析対象ジョブ数:** {{totalTargetJobs}}
**生成時刻:** {{generatedAt}}

---

## サマリ

{{overall-summary}}

### ジョブステータスの内訳

| ステータス | 件数 |
| --- | --- |
{{status-breakdown-rows}}

---

## ジョブ別分析

{{job-sections}}

---

## 推奨アクション

{{recommended-actions}}
`;

/**
 * ジョブ 1 件分のレポートブロックのデフォルトフォーマット。
 * ユーザは pipeline-report-settings.json の jobReportFormat で上書き可能。
 * プレースホルダ内の hint (`<...>`) は Agent への指示。列挙型 hint の場合は
 * 列挙値のみを出力すること。
 */
export const DEFAULT_JOB_REPORT_FORMAT = `### ジョブ #<jobId> — \`<jobName>\` (<stage> / <status>)

- **実行時間:** <duration>
- **Web URL:** <webUrl>
- **AI 総合評価:** <以下の3つから1つだけ選ぶ: 「問題なし」「要注意」「問題あり」。「問題なし」= ログ・アーティファクトの観察範囲で特筆すべき懸念がない場合 / 「要注意」= GitLab 上は成功だが警告・スキップ・無視されたエラー等の疑わしい徴候がある、または失敗だが影響範囲が軽微な場合 / 「問題あり」= ジョブが失敗している、または成功していても明確な問題（テストスキップ、エラー握り潰し、重要なリグレッション等）が検出されている場合>

**概要**
<1〜3文でこのジョブの顛末を要約>

**検出された問題**
<箇条書きで具体的な問題を列挙。GitLab 上は成功していても、ログから疑わしい徴候が見つかれば必ず記載する。何も検出されなかった場合は「検出なし」と書く>

**根拠（ログ・アーティファクト）**
- \`<ログ行またはアーティファクト抜粋>\` — <なぜこれが根拠になるのか>

**推奨される次のアクション**
<具体的なアクション、または「特になし」>
`;
```

**Step 3: エラークラスとパーサー実装**

`src/application/shared/parser/PipelineReportSettingsParseError.ts`:
```ts
export class PipelineReportSettingsParseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PipelineReportSettingsParseError';
  }
}
```

`src/application/shared/parser/parsePipelineReportSettings.ts`:
```ts
import { z } from 'zod';
import { PipelineReportSettings } from '../../../domain/pipeline-report/pipelineReportSettings/PipelineReportSettings.js';
import { DEFAULT_JOB_REPORT_FORMAT } from '../../pipeline-report/pipelineAnalysis/defaultReportFormat.js';
import { PipelineReportSettingsParseError } from './PipelineReportSettingsParseError.js';

const schema = z.object({
  jobReportFormat: z.string().optional(),
  additionalInstructions: z.string().nullable().optional(),
  includeJobPatterns: z.array(z.string()).optional(),
  excludeJobPatterns: z.array(z.string()).optional(),
});

export function parsePipelineReportSettings(jsonText: string): PipelineReportSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new PipelineReportSettingsParseError(
      `pipeline-report settings file is not valid JSON: ${(err as Error).message}`,
      err,
    );
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineReportSettingsParseError(
      `pipeline-report settings file has invalid shape: ${parsed.error.message}`,
      parsed.error,
    );
  }

  const compile = (patterns: string[] | undefined): RegExp[] => {
    if (!patterns) return [];
    return patterns.map((src) => {
      try {
        return new RegExp(src);
      } catch (err) {
        throw new PipelineReportSettingsParseError(
          `pipeline-report settings contains an invalid RegExp: "${src}" — ${(err as Error).message}`,
          err,
        );
      }
    });
  };

  return new PipelineReportSettings(
    parsed.data.jobReportFormat ?? DEFAULT_JOB_REPORT_FORMAT,
    parsed.data.additionalInstructions ?? null,
    compile(parsed.data.includeJobPatterns),
    compile(parsed.data.excludeJobPatterns),
  );
}
```

**Step 4: テスト実行 → 全グリーン**

Run: `npx vitest run src/application/shared/parser/__tests__/parsePipelineReportSettings.test.ts`
Expected: PASS (5/5)

**Step 5: コミット**

```bash
git add src/application/shared/parser/parsePipelineReportSettings.ts \
  src/application/shared/parser/PipelineReportSettingsParseError.ts \
  src/application/shared/parser/__tests__/parsePipelineReportSettings.test.ts \
  src/application/pipeline-report/pipelineAnalysis/defaultReportFormat.ts
git commit -m "feat: pipeline-reportの設定パーサーとデフォルトフォーマット定数を追加"
```

---

## Phase 3: Application 層 — 圧縮・アーカイブヘルパ

### Task 3-1: JobLogCompressor のテスト設計

review の `src/application/shared/diffCompression/__tests__/DiffCompressor.test.ts` を読んで、以下のシナリオに沿ったテストを設計する:

1. 閾値以下 → 非圧縮で返却 (`compressed=false`, `folderTreeStripped=false`)
2. folder tree ストリップのみで収まる
3. Step 2 Phase 1 (keepPercent) で収まる
4. Step 2 Phase 2 (keepLines 半減) で収まる
5. Best effort で抜けきれない場合、エラーを投げず compressed=true で返す
6. 省略マーカーに指定の文言が含まれる
7. `omittedJobLogs` に省略中央部分が記録される

### Task 3-2: JobLogCompressor を TDD で実装

**Files:**
- Create: `src/application/pipeline-report/pipelineAnalysis/JobLogCompressor.ts`
- Test: `src/application/pipeline-report/pipelineAnalysis/__tests__/JobLogCompressor.test.ts`

**Step 1: 失敗するテスト**

テストの骨格（TokenCounter は文字数をそのままトークン数として扱う fake を使う）:

```ts
import { describe, it, expect } from 'vitest';
import { compressJobLogsIfNeeded } from '../JobLogCompressor.js';
import type { TokenCounter } from '../../../shared/port/tokenCounter/TokenCounter.js';

const countingCounter: TokenCounter = {
  countTokens: (text: string) => text.length,
};

describe('JobLogCompressor', () => {
  const userPromptBuilder = (
    logs: Map<number, string>,
    folderTree: string,
  ): string =>
    `FOLDER:\n${folderTree}\nLOGS:\n${[...logs.entries()]
      .map(([id, t]) => `[${id}]\n${t}`)
      .join('\n')}`;

  const options = {
    maxContextLength: 500,
    thresholdRatio: 0.6, // threshold = 300 chars
    initialKeepPercent: 50,
    keepPercentStep: 10,
    minKeepPercent: 10,
  };

  // シナリオ 1-5 を記述
});
```

**Step 2: テスト実行 → 失敗確認**

Run: `npx vitest run src/application/pipeline-report/pipelineAnalysis/__tests__/JobLogCompressor.test.ts`
Expected: FAIL（モジュール未存在）

**Step 3: 実装**

`src/application/shared/diffCompression/DiffCompressor.ts` のアルゴリズムを正確に写し、以下の差し替えを行う:
- `splitDiffByFile` の代わりに `Map<number, string>`（ジョブログ）をそのまま使う
- `stripFilesFromFolderTree` は shared から import（変更なし）
- 省略マーカー文言: `[aikata: N chars omitted from middle of job log. Use getJobLogDetail tool with jobId to view omitted portion]`
- `compressFileDiff` → `compressJobLogByPercent`
- `compressFileDiffByLines` → `compressJobLogByLines`

`src/application/pipeline-report/pipelineAnalysis/JobLogCompressor.ts`:
```ts
import { stripFilesFromFolderTree } from '../../shared/diffCompression/FolderTreeStripper.js';
import type { TokenCounter } from '../../shared/port/tokenCounter/TokenCounter.js';

export interface JobLogCompressionOptions {
  maxContextLength: number;
  thresholdRatio: number;
  initialKeepPercent: number;
  keepPercentStep: number;
  minKeepPercent: number;
}

export interface JobLogCompressionResult {
  compressed: boolean;
  compressedJobLogs: Map<number, string>;
  folderTreeStripped: boolean;
  strippedFolderTree: string;
  omittedJobLogs: Map<number, string>;
  compressedJobIds: Set<number>;
}

const OMISSION_MARKER = (omittedChars: number): string =>
  `[aikata: ${omittedChars} chars omitted from middle of job log. Use getJobLogDetail tool with jobId to view omitted portion]`;

export function compressJobLogByPercent(
  fullText: string,
  keepPercent: number,
): { compressed: string; omitted: string } {
  const lines = fullText.split('\n');
  const totalLines = lines.length;
  const keepLines = Math.floor((totalLines * keepPercent) / 100);
  if (keepLines === 0 || keepLines * 2 >= totalLines) {
    return { compressed: fullText, omitted: '' };
  }
  const head = lines.slice(0, keepLines);
  const tail = lines.slice(totalLines - keepLines);
  const omittedLines = lines.slice(keepLines, totalLines - keepLines);
  const omittedText = omittedLines.join('\n');
  const marker = OMISSION_MARKER(omittedText.length);
  return {
    compressed: [...head, marker, ...tail].join('\n'),
    omitted: omittedText,
  };
}

export function compressJobLogByLines(
  fullText: string,
  keepLines: number,
): { compressed: string; omitted: string } {
  const lines = fullText.split('\n');
  const totalLines = lines.length;
  if (keepLines === 0) {
    if (totalLines <= 1) return { compressed: fullText, omitted: '' };
    const [first, ...rest] = lines;
    const marker = OMISSION_MARKER(rest.join('\n').length);
    return {
      compressed: [first, marker].join('\n'),
      omitted: rest.join('\n'),
    };
  }
  if (keepLines * 2 >= totalLines) {
    return { compressed: fullText, omitted: '' };
  }
  const head = lines.slice(0, keepLines);
  const tail = lines.slice(totalLines - keepLines);
  const omittedLines = lines.slice(keepLines, totalLines - keepLines);
  const omittedText = omittedLines.join('\n');
  const marker = OMISSION_MARKER(omittedText.length);
  return {
    compressed: [...head, marker, ...tail].join('\n'),
    omitted: omittedText,
  };
}

export function compressJobLogsIfNeeded(
  userPromptBuilder: (logs: Map<number, string>, folderTree: string) => string,
  originalLogs: Map<number, string>,
  folderTree: string,
  tokenCounter: TokenCounter,
  options: JobLogCompressionOptions,
): JobLogCompressionResult {
  const threshold = options.maxContextLength * options.thresholdRatio;
  const isUnderThreshold = (logs: Map<number, string>, ft: string): boolean =>
    tokenCounter.countTokens(userPromptBuilder(logs, ft)) <= threshold;

  if (isUnderThreshold(originalLogs, folderTree)) {
    return {
      compressed: false,
      compressedJobLogs: new Map(originalLogs),
      folderTreeStripped: false,
      strippedFolderTree: folderTree,
      omittedJobLogs: new Map(),
      compressedJobIds: new Set(),
    };
  }

  // Step 1: folderTree からファイル行を除去
  const strippedFolderTree = stripFilesFromFolderTree(folderTree);
  const currentFolderTree = strippedFolderTree;
  const folderTreeStripped = strippedFolderTree !== folderTree;

  if (isUnderThreshold(originalLogs, currentFolderTree)) {
    return {
      compressed: true,
      compressedJobLogs: new Map(originalLogs),
      folderTreeStripped,
      strippedFolderTree,
      omittedJobLogs: new Map(),
      compressedJobIds: new Set(),
    };
  }

  // Step 2 Phase 1: keepPercent ベース反復圧縮
  const currentLogs = new Map<number, string>(originalLogs);
  const omittedJobLogs = new Map<number, string>();
  const compressedJobIds = new Set<number>();
  const keepPercents = new Map<number, number>();

  const getLineCount = (id: number): number => {
    const txt = currentLogs.get(id);
    return txt ? txt.split('\n').length : 0;
  };

  for (;;) {
    const sorted = [...currentLogs.keys()].sort((a, b) => getLineCount(b) - getLineCount(a));
    let target: number | null = null;
    for (const id of sorted) {
      const kp = keepPercents.get(id);
      if (kp !== undefined && kp <= options.minKeepPercent) continue;
      target = id;
      break;
    }
    if (target === null) break;

    const kp = keepPercents.get(target);
    const newKp = kp === undefined
      ? options.initialKeepPercent
      : Math.max(kp - options.keepPercentStep, options.minKeepPercent);
    keepPercents.set(target, newKp);

    const originalText = originalLogs.get(target)!;
    const { compressed, omitted } = compressJobLogByPercent(originalText, newKp);
    currentLogs.set(target, compressed);
    if (omitted) {
      omittedJobLogs.set(target, omitted);
      compressedJobIds.add(target);
    }
    if (isUnderThreshold(currentLogs, currentFolderTree)) {
      return {
        compressed: true,
        compressedJobLogs: currentLogs,
        folderTreeStripped,
        strippedFolderTree,
        omittedJobLogs,
        compressedJobIds,
      };
    }
  }

  // Step 2 Phase 2: keepLines 半減反復
  const keepLines = new Map<number, number>();
  for (const [id, kp] of keepPercents) {
    if (kp <= options.minKeepPercent) {
      const originalText = originalLogs.get(id)!;
      const totalLines = originalText.split('\n').length;
      const kl = Math.floor((totalLines * kp) / 100);
      if (kl > 0) keepLines.set(id, kl);
    }
  }

  for (;;) {
    const sorted = [...currentLogs.keys()].sort((a, b) => getLineCount(b) - getLineCount(a));
    let target: number | null = null;
    for (const id of sorted) {
      if (!keepLines.has(id)) continue;
      if (keepLines.get(id)! <= 0) continue;
      target = id;
      break;
    }
    if (target === null) break;

    const current = keepLines.get(target)!;
    const next = Math.floor(current / 2);
    keepLines.set(target, next);

    const originalText = originalLogs.get(target)!;
    const { compressed, omitted } = compressJobLogByLines(originalText, next);
    currentLogs.set(target, compressed);
    if (omitted) {
      omittedJobLogs.set(target, omitted);
      compressedJobIds.add(target);
    }
    if (isUnderThreshold(currentLogs, currentFolderTree)) {
      return {
        compressed: true,
        compressedJobLogs: currentLogs,
        folderTreeStripped,
        strippedFolderTree,
        omittedJobLogs,
        compressedJobIds,
      };
    }
  }

  // Best effort (抜けきれなくてもエラーは投げない)
  return {
    compressed: true,
    compressedJobLogs: currentLogs,
    folderTreeStripped,
    strippedFolderTree,
    omittedJobLogs,
    compressedJobIds,
  };
}
```

**Step 4: テスト通過確認**

Run: `npx vitest run src/application/pipeline-report/pipelineAnalysis/__tests__/JobLogCompressor.test.ts`
Expected: PASS

**Step 5: コミット**

```bash
git add src/application/pipeline-report/pipelineAnalysis/JobLogCompressor.ts \
  src/application/pipeline-report/pipelineAnalysis/__tests__/JobLogCompressor.test.ts
git commit -m "feat: pipeline-reportのジョブログ圧縮器を追加"
```

### Task 3-3: yauzl 依存追加

**Step 1: package.json への追加**

Run:
```bash
npm install --save yauzl
npm install --save-dev @types/yauzl
```
Expected: `package.json` と `package-lock.json` が更新される

**Step 2: インストール確認**

Run: `node -e "console.log(require('yauzl').open.length)"`
Expected: 数値（関数の引数数）

**Step 3: コミット**

```bash
git add package.json package-lock.json
git commit -m "chore: pipeline-reportのzipパース用にyauzlを追加"
```

### Task 3-4: テスト用 zip フィクスチャを作成

**Files:**
- Create: `src/application/pipeline-report/pipelineAnalysis/__tests__/fixtures/artifacts/README.md`
- Create: `src/application/pipeline-report/pipelineAnalysis/__tests__/fixtures/artifacts/sample.zip` (バイナリ)

**Step 1: フィクスチャ生成用スクリプト（ワンショット）**

`src/application/pipeline-report/pipelineAnalysis/__tests__/fixtures/artifacts/README.md` に以下の手順を記載:

```
このディレクトリの sample.zip は以下の手順で生成した:

1. 一時ディレクトリに以下のファイルを用意:
   - content-a.txt: "hello world"
   - content-b.txt: "binary\u0000data"
2. Node スクリプトで yauzl の書き込み版 (yazl) または
   Node 標準の child_process (execFile) を使い zip を生成
3. 生成された zip を本ディレクトリにコピー

テスト中は常に pre-built の sample.zip を読むだけで、
テストコード内で zip の動的生成は行わない。
```

**Step 2: 実際に zip を作成**

本プロジェクトでは `execFile` を使ったワンショットスクリプトで生成する（`src/utils/execFileNoThrow.ts` を使用）:

```ts
// tools/scripts/gen-test-fixtures.ts (一時的な生成スクリプト、コミット対象)
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileNoThrow } from '../../src/utils/execFileNoThrow.js';

const tmp = await mkdtemp(join(tmpdir(), 'gen-fixture-'));
await writeFile(join(tmp, 'content-a.txt'), 'hello world');
await writeFile(join(tmp, 'content-b.txt'), Buffer.from('binary\x00data'));
const zipPath = join(tmp, 'sample.zip');
await execFileNoThrow('zip', ['-q', '-j', zipPath, join(tmp, 'content-a.txt'), join(tmp, 'content-b.txt')], { cwd: tmp });
await copyFile(
  zipPath,
  resolve('src/application/pipeline-report/pipelineAnalysis/__tests__/fixtures/artifacts/sample.zip'),
);
console.log('done');
```

このスクリプトを `npx tsx tools/scripts/gen-test-fixtures.ts` で 1 回だけ実行して sample.zip を生成し、スクリプト自体もコミットする（再生成の手順として）。

**Step 3: 生成された zip をコミット**

```bash
git add src/application/pipeline-report/pipelineAnalysis/__tests__/fixtures/ tools/scripts/gen-test-fixtures.ts
git commit -m "test: pipeline-reportのartifactArchiveReaderテスト用zipフィクスチャを追加"
```

### Task 3-5: YauzlArtifactArchiveReader の TDD

**Files:**
- Create: `src/application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.ts`
- Test: `src/application/pipeline-report/pipelineAnalysis/__tests__/ArtifactArchiveReader.test.ts`

**Step 1: 失敗するテスト（pre-built フィクスチャを使う）**

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { YauzlArtifactArchiveReader } from '../ArtifactArchiveReader.js';

const FIXTURE_ZIP = resolve(
  __dirname,
  'fixtures/artifacts/sample.zip',
);

describe('YauzlArtifactArchiveReader', () => {
  it('should list entries in the fixture zip', async () => {
    const reader = new YauzlArtifactArchiveReader();
    const entries = await reader.listEntries(FIXTURE_ZIP);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['content-a.txt', 'content-b.txt']);
    expect(entries.find((e) => e.path === 'content-a.txt')?.type).toBe('file');
  });

  it('should read a file by inner path', async () => {
    const reader = new YauzlArtifactArchiveReader();
    const result = await reader.readFile(FIXTURE_ZIP, 'content-a.txt', { maxBytes: 1024 });
    expect(result.data.toString('utf8')).toBe('hello world');
    expect(result.truncated).toBe(false);
  });

  it('should truncate when over maxBytes', async () => {
    const reader = new YauzlArtifactArchiveReader();
    const result = await reader.readFile(FIXTURE_ZIP, 'content-a.txt', { maxBytes: 5 });
    expect(result.data.length).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('should throw for missing entry', async () => {
    const reader = new YauzlArtifactArchiveReader();
    await expect(
      reader.readFile(FIXTURE_ZIP, 'nonexistent.txt', { maxBytes: 1024 }),
    ).rejects.toThrow();
  });
});
```

**Step 2-4: 実装**

`src/application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.ts`:
```ts
import yauzl from 'yauzl';
import type { ArtifactEntry } from '../../../domain/pipeline-report/artifact/ArtifactEntry.js';

export interface ArtifactArchiveReader {
  listEntries(zipPath: string): Promise<ArtifactEntry[]>;
  readFile(
    zipPath: string,
    innerPath: string,
    options: { maxBytes: number },
  ): Promise<{ data: Buffer; truncated: boolean }>;
}

export class YauzlArtifactArchiveReader implements ArtifactArchiveReader {
  async listEntries(zipPath: string): Promise<ArtifactEntry[]> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        if (!zipfile) return reject(new Error('zipfile is null'));
        const results: ArtifactEntry[] = [];
        zipfile.on('entry', (entry: yauzl.Entry) => {
          const isDir = /\/$/.test(entry.fileName);
          results.push({
            path: entry.fileName,
            type: isDir ? 'tree' : 'file',
            size: entry.uncompressedSize,
            mode: (entry.externalFileAttributes >>> 16).toString(8).padStart(6, '0'),
          });
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolve(results));
        zipfile.on('error', reject);
        zipfile.readEntry();
      });
    });
  }

  async readFile(
    zipPath: string,
    innerPath: string,
    options: { maxBytes: number },
  ): Promise<{ data: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        if (!zipfile) return reject(new Error('zipfile is null'));
        let found = false;
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (entry.fileName !== innerPath) {
            zipfile.readEntry();
            return;
          }
          found = true;
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) {
              zipfile.close();
              return reject(err2 ?? new Error('stream is null'));
            }
            const chunks: Buffer[] = [];
            let total = 0;
            let truncated = false;
            stream.on('data', (chunk: Buffer) => {
              if (total >= options.maxBytes) {
                truncated = true;
                return;
              }
              const remaining = options.maxBytes - total;
              if (chunk.length > remaining) {
                chunks.push(chunk.subarray(0, remaining));
                total += remaining;
                truncated = true;
              } else {
                chunks.push(chunk);
                total += chunk.length;
              }
            });
            stream.on('end', () => {
              zipfile.close();
              resolve({ data: Buffer.concat(chunks), truncated });
            });
            stream.on('error', (e) => {
              zipfile.close();
              reject(e);
            });
          });
        });
        zipfile.on('end', () => {
          if (!found) reject(new Error(`artifact entry not found: ${innerPath}`));
        });
        zipfile.on('error', reject);
        zipfile.readEntry();
      });
    });
  }
}
```

Run: `npx vitest run src/application/pipeline-report/pipelineAnalysis/__tests__/ArtifactArchiveReader.test.ts`
Expected: PASS (4/4)

**Step 5: コミット**

```bash
git add src/application/pipeline-report/pipelineAnalysis/ArtifactArchiveReader.ts \
  src/application/pipeline-report/pipelineAnalysis/__tests__/ArtifactArchiveReader.test.ts
git commit -m "feat: pipeline-reportのyauzlベースartifactArchiveReaderを追加"
```

### Task 3-6: ArtifactCacheManager

**Files:**
- Create: `src/application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.ts`
- Test: `src/application/pipeline-report/pipelineAnalysis/__tests__/ArtifactCacheManager.test.ts`

**Step 1: テスト設計**

`ArtifactCacheManager` は `PipelineGateway.downloadArtifactArchive` を呼び出す。テストでは fake gateway を使う。

主要シナリオ:
1. `hasArtifacts=false` のジョブはスキップ（値 `{ kind: 'no-artifacts' }`）
2. `artifactsSize > maxArtifactZipBytes` のジョブはスキップ（`{ kind: 'skipped-too-large' }`）
3. 合計ダウンロードサイズが `totalDiskBytes` を超えると以降はスキップ（`{ kind: 'skipped-disk-full' }`）
4. 正常系では zip が temp ディレクトリに保存され `{ kind: 'cached', zipPath, bytes }`
5. `cleanup()` で temp ディレクトリが削除される
6. gateway が例外を投げた場合 `{ kind: 'error', reason }`

**Step 2-4: 実装**

`src/application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.ts`:
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineGateway } from '../../shared/port/gateway/PipelineGateway.js';
import type { Job } from '../../../domain/pipeline-report/job/Job.js';

export type ArtifactCacheEntryStatus =
  | { kind: 'cached'; zipPath: string; bytes: number }
  | { kind: 'no-artifacts' }
  | { kind: 'skipped-too-large'; sizeBytes: number }
  | { kind: 'skipped-disk-full'; sizeBytes: number }
  | { kind: 'error'; reason: string };

export interface ArtifactCacheOptions {
  maxArtifactZipBytes: number;
  totalDiskBytes: number;
}

export class ArtifactCacheManager {
  private tempDir: string | null = null;
  private totalBytes = 0;
  private entries = new Map<number, ArtifactCacheEntryStatus>();

  constructor(
    private readonly gateway: PipelineGateway,
    private readonly options: ArtifactCacheOptions,
  ) {}

  async prefetchForJobs(
    projectId: number,
    jobs: readonly Job[],
  ): Promise<Map<number, ArtifactCacheEntryStatus>> {
    this.tempDir = await mkdtemp(join(tmpdir(), 'aikata-pipeline-report-'));
    for (const job of jobs) {
      if (!job.hasArtifacts) {
        this.entries.set(job.id, { kind: 'no-artifacts' });
        continue;
      }
      if (job.artifactsSize > this.options.maxArtifactZipBytes) {
        this.entries.set(job.id, {
          kind: 'skipped-too-large',
          sizeBytes: job.artifactsSize,
        });
        continue;
      }
      if (this.totalBytes + job.artifactsSize > this.options.totalDiskBytes) {
        this.entries.set(job.id, {
          kind: 'skipped-disk-full',
          sizeBytes: job.artifactsSize,
        });
        continue;
      }
      const zipPath = join(this.tempDir, `job-${job.id}.zip`);
      try {
        const result = await this.gateway.downloadArtifactArchive(projectId, job.id, zipPath, {
          maxBytes: this.options.maxArtifactZipBytes,
        });
        this.totalBytes += result.bytesWritten;
        this.entries.set(job.id, {
          kind: 'cached',
          zipPath,
          bytes: result.bytesWritten,
        });
      } catch (err) {
        this.entries.set(job.id, {
          kind: 'error',
          reason: (err as Error).message,
        });
      }
    }
    return this.entries;
  }

  getZipPath(jobId: number): string | null {
    const entry = this.entries.get(jobId);
    if (entry?.kind === 'cached') return entry.zipPath;
    return null;
  }

  getCachePaths(): Map<number, string | null> {
    const result = new Map<number, string | null>();
    for (const [id, entry] of this.entries) {
      result.set(id, entry.kind === 'cached' ? entry.zipPath : null);
    }
    return result;
  }

  async cleanup(): Promise<void> {
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
    this.entries.clear();
    this.totalBytes = 0;
  }
}
```

テストは fake `PipelineGateway` を inline で定義し、6 シナリオを検証する。

**Step 5: テスト通過 → コミット**

```bash
git add src/application/pipeline-report/pipelineAnalysis/ArtifactCacheManager.ts \
  src/application/pipeline-report/pipelineAnalysis/__tests__/ArtifactCacheManager.test.ts
git commit -m "feat: pipeline-reportのartifactCacheManagerを追加"
```

---

## Phase 4: Application 層 — PipelineContextBuilder と PipelineAnalysisService

### Task 4-1: pipelineContextBuilder

**Files:**
- Create: `src/application/pipeline-report/pipelineAnalysis/pipelineContextBuilder.ts`
- Test: `src/application/pipeline-report/pipelineAnalysis/__tests__/pipelineContextBuilder.test.ts`

pipelineAnalysisAgent に渡すユーザプロンプトの文字列組み立てロジック。`userPromptBuilder(logs, folderTree)` のクロージャとして使えるよう関数形に実装する。

主要責務:
- pipeline メタ情報ヘッダ
- 対象ジョブ一覧（表形式）
- 各ジョブのログセクション
- アーティファクトツリー一覧（job ごと）
- ソースコードパス（folderTree）

詳細は設計書 §3.1 末尾のユーザプロンプト例を参照。

**Step 1-5: TDD で実装してコミット**

```bash
git commit -m "feat: pipelineContextBuilderでユーザプロンプト組み立てロジックを追加"
```

### Task 4-2: PipelineAnalysisService

**Files:**
- Create: `src/application/pipeline-report/pipelineAnalysis/PipelineAnalysisService.ts`
- Test: `src/application/pipeline-report/pipelineAnalysis/__tests__/PipelineAnalysisService.test.ts`

設計書 §5.1 に沿った 13 ステップのフローを実装する。テストは古典派で fake 依存を使う。

主要シナリオ:
1. 正常系（全ステップ成功、完成判定済み）
2. ジョブ 0 件（filter 結果が空）→ 空のレポート or skip
3. GitLab API 失敗 → エラー伝播
4. zip ダウンロード失敗 → 対象ジョブは `error` マーク付けて続行（リトライ不要）
5. workflow が非完成で返す → `completenessVerified=false` のまま返る
6. finally でクリーンアップが呼ばれる

**Step 1-5: TDD で実装してコミット**

```bash
git commit -m "feat: pipelineAnalysisServiceを追加"
```

### Task 4-3: Application 層テスト全通過確認

```bash
npx vitest run src/application/pipeline-report/
npm run lint
npm run build:cli
```
Expected: 全てグリーン

---

## Phase 5: Infrastructure 層 — GitLabPipelineGateway

### Task 5-1: GitLabPipelineGateway の TDD

**Files:**
- Create: `src/infrastructure/adapter/pipeline-report/gateway/GitLabPipelineGateway.ts`
- Test: `src/infrastructure/adapter/pipeline-report/gateway/__tests__/GitLabPipelineGateway.test.ts`

既存 `src/infrastructure/adapter/httpClient/GitLabApiClient.ts` を依存として使う。

主要責務:
- `getPipeline(projectId, pipelineId)`: `GET /projects/:id/pipelines/:pipeline_id` を呼び domain に変換
- `getJobs(...)`: `GET /projects/:id/pipelines/:pipeline_id/jobs?include_retried=false&per_page=100` をページネーション全取得
- `getJobTrace(...)`: `GET /projects/:id/jobs/:job_id/trace` を取得（content-type は `text/plain` 前提）
- `downloadArtifactArchive(...)`: `GET /projects/:id/jobs/:job_id/artifacts` を fs に保存（maxBytes で切る）

テストでは GitLabApiClient を mock し、リクエスト URL / パラメータ / 変換結果を検証する。

**Step 1-5: TDD で実装してコミット**

```bash
git commit -m "feat: gitLabPipelineGatewayを追加"
```

### Task 5-2: Infrastructure 層ビルド確認

```bash
npm run test
npm run lint
npm run build:cli
```

---

## Phase 6: Mastra 層 — Request Context と共通 readImage 共有化

### Task 6-1: readImage を shared に移動（最小限の共通化）

**Files:**
- Create: `src/mastra/shared/readImageCommon.ts`（key/prefix 定数のみ shared に切り出し）
- Modify: `src/mastra/review/tools/readImage.ts`（定数を shared から import、他は変更しない）

**Step 1: shared に定数を切り出し**

`src/mastra/shared/readImageCommon.ts`:
```ts
export const PENDING_IMAGES_KEY = 'pendingImages';
export const READ_IMAGE_TOOL_KEY = 'readImage';
export const IMAGE_MESSAGE_PREFIX = 'The readImage tool was used to retrieve';
```

**Step 2: review の readImage.ts を更新**

既存 `src/mastra/review/tools/readImage.ts` の該当定数の宣言を削除し、`import { PENDING_IMAGES_KEY, READ_IMAGE_TOOL_KEY, IMAGE_MESSAGE_PREFIX } from '../../shared/readImageCommon.js'` に置き換える。他のロジックは変更しない。

**Step 3: review のテストが壊れないことを確認**

Run: `npx vitest run src/mastra/review/`
Expected: PASS（変更前と同じ）

**Step 4: コミット**

```bash
git add src/mastra/shared/readImageCommon.ts src/mastra/review/tools/readImage.ts
git commit -m "refactor: readImageツールの共通定数をsharedに切り出し"
```

### Task 6-2: pipeline-report 用 RequestContext

**Files:**
- Create: `src/mastra/pipeline-report/requestContext.ts`
- Create: `src/mastra/pipeline-report/types.ts`

設計書 §6.6 に沿った型定義:

```ts
// types.ts
import type { JobStatus } from '../../domain/pipeline-report/job/JobStatus.js';

export interface TargetJobSummary {
  id: number;
  name: string;
  stage: string;
  status: JobStatus;
  duration: number | null;
}

// requestContext.ts
import type { TargetJobSummary } from './types.js';

export interface WorkflowAiConfig {
  apiKey: string;
  endpointUrl: string;
  modelName: string;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
}

export interface PipelineAnalysisAgentRequestContext {
  userId: string;
  projectId: number;
  pipelineId: number;
  projectDir: string;
  aiConfig: WorkflowAiConfig;
  targetJobs: TargetJobSummary[];
  overallTemplate: string;
  jobReportFormat: string;
  additionalInstructions: string | null;
  commentLanguage: string;
  resultFilePath: string;
  skillsPaths: string[];
  folderTree: string;
  folderTreeStripped: boolean;
  omittedJobLogs: Map<number, string>;
  artifactCachePaths: Map<number, string | null>;
  hasImages: boolean;
  pendingImages: Map<string, { base64: string; mimeType: string }>;
}

export interface ReportCompletenessJudgeRequestContext {
  userId: string;
  aiConfig: WorkflowAiConfig;
}

export interface PipelineReportSummarizationRequestContext {
  userId: string;
  aiConfig: WorkflowAiConfig;
  targetJobs: TargetJobSummary[];
}
```

**Step 1-3: 実装してコミット**

```bash
git add src/mastra/pipeline-report/requestContext.ts src/mastra/pipeline-report/types.ts
git commit -m "feat: pipeline-reportのrequestContextと型定義を追加"
```

---

## Phase 7: Mastra 層 — Tools

各 tool は `@mastra/core` の `createTool` で実装する。`src/mastra/review/tools/*.ts` を参考にする。

### Task 7-1: writeReport tool

**Files:**
- Create: `src/mastra/pipeline-report/tools/writeReport.ts`
- Test: `src/mastra/pipeline-report/tools/__tests__/writeReport.test.ts`

実装要点:
- `resultFilePath` は RequestContext から取得
- `mkdir` ベースのファイルロック (`src/mastra/review/tools/storeReviewResult.ts` の `acquireLock` 関数をコピーして流用)
- input: `{ content: string }`
- output: `{ success: boolean; charsWritten: number }`

**Step 1-5: TDD → コミット**

```bash
git commit -m "feat: pipeline-reportのwriteReportツールを追加"
```

### Task 7-2: patchReport tool

**Files:**
- Create: `src/mastra/pipeline-report/tools/patchReport.ts`
- Test: `src/mastra/pipeline-report/tools/__tests__/patchReport.test.ts`

実装要点:
- input: `{ oldString: string; newString: string; replaceAll?: boolean }`
- `replaceAll=false` (default) で `oldString` が複数マッチするなら `{ success: false, error: 'ambiguous' }`
- 見つからないなら `{ success: false, error: 'not-found' }`
- 成功なら `{ success: true, matchCount: n }`

```bash
git commit -m "feat: pipeline-reportのpatchReportツールを追加"
```

### Task 7-3: getReport tool

**Files:**
- Create: `src/mastra/pipeline-report/tools/getReport.ts`
- Test: `src/mastra/pipeline-report/tools/__tests__/getReport.test.ts`

実装要点:
- input: なし
- output: `{ content: string }`

```bash
git commit -m "feat: pipeline-reportのgetReportツールを追加"
```

### Task 7-4: getJobLogDetail tool

**Files:**
- Create: `src/mastra/pipeline-report/tools/getJobLogDetail.ts`
- Test: `src/mastra/pipeline-report/tools/__tests__/getJobLogDetail.test.ts`

実装要点:
- input: `{ jobId: number }`
- `RequestContext.omittedJobLogs.get(jobId)` を返却
- 無ければ `{ omittedText: null, reason: 'log was not compressed for this job' }`

```bash
git commit -m "feat: pipeline-reportのgetJobLogDetailツールを追加"
```

### Task 7-5: getArtifactContent tool

**Files:**
- Create: `src/mastra/pipeline-report/tools/getArtifactContent.ts`
- Test: `src/mastra/pipeline-report/tools/__tests__/getArtifactContent.test.ts`

実装要点:
- input: `{ jobId: number; artifactPath: string }`
- `RequestContext.artifactCachePaths.get(jobId)` で zip パスを取得
- `YauzlArtifactArchiveReader.readFile(zipPath, artifactPath, { maxBytes: PIPELINE_REPORT_MAX_ARTIFACT_FILE_BYTES })`
- MIME 判定:
  - 画像（PNG/JPEG/GIF/WebP）→ `pendingImages` に push、`{ kind: 'image', mimeType }` を返却
  - テキスト（UTF-8 decodable）→ `{ kind: 'text', content, truncated }`
  - その他 → `{ kind: 'unsupported', mimeType, size, reason }`

参考: review `src/mastra/review/tools/readImage.ts` の MIME 判定・base64 化ロジック

```bash
git commit -m "feat: pipeline-reportのgetArtifactContentツールを追加"
```

### Task 7-6: Mastra ツール層テスト全通過確認

```bash
npx vitest run src/mastra/pipeline-report/tools/
npm run lint && npm run build:cli
```

---

## Phase 8: Mastra 層 — Agents

### Task 8-1: pipelineReportSummarizationAgent

**Files:**
- Create: `src/mastra/pipeline-report/agents/pipelineReportSummarizationAgent.ts`
- Test: `src/mastra/pipeline-report/agents/__tests__/pipelineReportSummarizationAgent.test.ts`

review の `src/mastra/review/agents/summarizationAgent.ts` を参考に、設計書 §6.3 のシステムプロンプトで実装。Tools なし、構造化出力なしのシンプルな要約 Agent。

```bash
git commit -m "feat: pipeline-reportのsummarizationAgentを追加"
```

### Task 8-2: reportCompletenessJudgeAgent

**Files:**
- Create: `src/mastra/pipeline-report/agents/reportCompletenessJudgeAgent.ts`
- Test: `src/mastra/pipeline-report/agents/__tests__/reportCompletenessJudgeAgent.test.ts`

設計書 §6.2 のシステムプロンプト + zod 出力スキーマで実装。Tools なし。

出力スキーマ:
```ts
const schema = z.object({
  isComplete: z.boolean(),
  missingItems: z.array(z.object({
    jobId: z.number(),
    jobName: z.string(),
    reason: z.string(),
  })),
  formatDeviations: z.array(z.string()),
});
```

```bash
git commit -m "feat: pipeline-reportのreportCompletenessJudgeAgentを追加"
```

### Task 8-3: pipelineAnalysisAgent (buildInstructions + tool set factory)

**Files:**
- Create: `src/mastra/pipeline-report/agents/pipelineAnalysisAgent.ts`
- Test: `src/mastra/pipeline-report/agents/__tests__/pipelineAnalysisAgent.test.ts`

review `src/mastra/review/agents/reviewAgent.ts` を参考。

主要責務:
- `buildInstructions(ctx)`: 設計書 §6.1 のテンプレートを条件分岐付きで組み立てる
  - `omittedJobLogs.size > 0` の場合のみ `getJobLogDetail` 言及
  - `hasImages` の場合のみ `readImage` 言及
  - `folderTreeStripped` の場合のみ Source Code Paths の注意書き
- `buildUserPrompt(ctx, jobLogsCompressed, artifactTrees)`: pipelineContextBuilder を呼んで組み立て
- `createAgent(ctx, tools)`: Mastra の `Agent` コンストラクタで instantiate
- `createToolset(ctx)`: workspace tools + 条件付き pipeline-report tools を返す

テストでは `buildInstructions` の条件分岐を網羅する:
- tools/notes が条件に応じて入る/入らない
- `additionalInstructions` が null なら対応セクションが省かれる
- 対象ジョブ一覧がちゃんと入る
- `commentLanguage` が writing constraints に反映される

```bash
git commit -m "feat: pipeline-reportのpipelineAnalysisAgentを追加"
```

### Task 8-4: Mastra agent 層テスト全通過確認

```bash
npx vitest run src/mastra/pipeline-report/agents/
npm run lint && npm run build:cli
```

---

## Phase 9: Mastra 層 — Workflow と Steps

### Task 9-1: contextLengthRecovery step

**Files:**
- Create: `src/mastra/pipeline-report/workflows/steps/contextLengthRecovery.ts`
- Test: `src/mastra/pipeline-report/workflows/steps/__tests__/contextLengthRecovery.test.ts`

review の `src/mastra/review/workflows/steps/contextLengthRecovery.ts` を参考。主要動作:
- メッセージ列をシリアライズ（`MAX_SERIALIZED_CHARS = 80000`）
- 超過分は中央カット
- `pipelineReportSummarizationAgent` で要約
- 旧スレッド削除、新スレッド作成

```bash
git commit -m "feat: pipeline-reportのcontextLengthRecoveryステップを追加"
```

### Task 9-2: executeAnalysisStep

**Files:**
- Create: `src/mastra/pipeline-report/workflows/steps/executeAnalysisStep.ts`
- Test: `src/mastra/pipeline-report/workflows/steps/__tests__/executeAnalysisStep.test.ts`

主要動作:
- `resultFilePath` に `OVERALL_REPORT_TEMPLATE` を書き込み
- `pipelineAnalysisAgent.stream(userPrompt, { memory, toolsets, prepareStep })`
- context length エラー検知で `contextLengthRecovery` を呼ぶ（最大 3 回）
- 終了後 `resultFilePath` の内容を返す

```bash
git commit -m "feat: pipeline-reportのexecuteAnalysisStepを追加"
```

### Task 9-3: verifyCompletenessStep

**Files:**
- Create: `src/mastra/pipeline-report/workflows/steps/verifyCompletenessStep.ts`
- Test: `src/mastra/pipeline-report/workflows/steps/__tests__/verifyCompletenessStep.test.ts`

主要動作:
- 現在のレポート内容を読み込む
- `reportCompletenessJudgeAgent.generate(...)` で JSON 判定
- `isComplete=true` → 完了
- `isComplete=false` & `retries < max` → フィードバック文字列を組み立てて同一スレッドに投入 → `pipelineAnalysisAgent` 再実行 → 再度 verify
- `retries` 上限到達時は警告ログを出力して現状を返す

フィードバックメッセージの組み立ては設計書 §6.1 の「再実行フィードバック」を参考。

```bash
git commit -m "feat: pipeline-reportのverifyCompletenessStepを追加"
```

### Task 9-4: pipelineAnalysisWorkflow

**Files:**
- Create: `src/mastra/pipeline-report/workflows/pipelineAnalysisWorkflow.ts`
- Test: `src/mastra/pipeline-report/workflows/__tests__/pipelineAnalysisWorkflow.test.ts`

設計書 §6.5 の入出力スキーマ + ステップ連結で実装:
1. `executeAnalysisStep` → `verifyCompletenessStep`
2. verify が `isComplete=false` なら executeAnalysisStep の再実行が step 内部ループで行われる

Mastra の workflow API に合わせて `createWorkflow().step(executeAnalysisStep).then(verifyCompletenessStep).commit()` のような形。

```bash
git commit -m "feat: pipeline-reportのworkflowを追加"
```

### Task 9-5: Mastra index.ts への登録

**Files:**
- Modify: `src/mastra/index.ts`

**Step 1: 既存の `src/mastra/index.ts` を読む**

Read: `src/mastra/index.ts`

**Step 2: pipeline-report 系 agents と workflow を追加**

`agents` オブジェクトに:
- `pipelineAnalysisAgent`
- `reportCompletenessJudgeAgent`
- `pipelineReportSummarizationAgent`

`workflows` オブジェクトに:
- `pipelineAnalysisWorkflow`

**Step 3: テストを追加**

`src/mastra/__tests__/index.test.ts` に pipeline-report 系エージェント/workflow が登録されていることをアサーションで検証（既存パターンに従う）。

**Step 4-5: テスト通過 → コミット**

```bash
git add src/mastra/index.ts src/mastra/__tests__/
git commit -m "feat: mastra/index.tsにpipeline-report系agent/workflowを登録"
```

### Task 9-6: Mastra 層全体テスト通過確認

```bash
npx vitest run src/mastra/
npm run lint && npm run build:cli
```

---

## Phase 10: Infrastructure 層 — MastraPipelineAnalysisWorkflowRunner

### Task 10-1: 実装

**Files:**
- Create: `src/infrastructure/adapter/pipeline-report/workflow/MastraPipelineAnalysisWorkflowRunner.ts`
- Test: `src/infrastructure/adapter/pipeline-report/workflow/__tests__/MastraPipelineAnalysisWorkflowRunner.test.ts`

`src/infrastructure/adapter/review/workflow/MastraReviewWorkflowRunner.ts` を参考。`mastra.getWorkflow('pipelineAnalysisWorkflow')` を呼び、入出力を domain / port の型に変換する。

`runWithLogContext` 呼び出しはこの runner の `run()` 内で行い、下流の `getLogger()` にバインディングを伝播させる。

**Step 1-5: TDD で実装してコミット**

```bash
git commit -m "feat: mastraPipelineAnalysisWorkflowRunnerを追加"
```

---

## Phase 11: Presentation 層 — API

### Task 11-1: pipelineReportHandler

**Files:**
- Create: `src/presentation/api/pipeline-report/pipelineReportHandler.ts`
- Test: `src/presentation/api/pipeline-report/__tests__/pipelineReportHandler.test.ts`

参考: `src/presentation/api/review/reviewHandler.ts`

主要責務:
1. リクエストボディの zod バリデーション
2. JWT クレーム抽出 (`c.get('jwtPayload')`)
3. `runWithLogContext({ userId, requestId, gitlabUserId, ... }, async () => { ... })` で下流を包む
4. `CloneManager.clone(projectId, ref)` でリポジトリ取得
5. `PipelineAnalysisService.analyze(...)` 呼び出し
6. SSE ストリームで進捗 + 最終レポート
7. finally で CloneManager / ArtifactCacheManager をクリーンアップ

```bash
git commit -m "feat: pipeline-report API ハンドラを追加"
```

### Task 11-2: pipelineReportRoute

**Files:**
- Create: `src/presentation/api/pipeline-report/pipelineReportRoute.ts`
- Test: `src/presentation/api/pipeline-report/__tests__/pipelineReportRoute.test.ts`

参考: `src/presentation/api/review/reviewRoute.ts`

`POST /api/v1/pipeline-report` を登録し、ハンドラを呼ぶ。

```bash
git commit -m "feat: pipeline-report APIルートを追加"
```

### Task 11-3: pipelineReportApiModule

**Files:**
- Create: `src/presentation/api/pipeline-report/index.ts`

```ts
import type { ApiFeatureModule } from '../shared/featureModule.js';
import { createPipelineReportRoute } from './pipelineReportRoute.js';

export const pipelineReportApiModule: ApiFeatureModule = {
  name: 'pipeline-report',
  register(app) {
    createPipelineReportRoute(app);
  },
};
```

```bash
git commit -m "feat: pipelineReportApiModuleを追加"
```

### Task 11-4: server.ts への登録

**Files:**
- Modify: `src/server.ts`

**Step 1: 既存の `apiFeatures` 配列を読む**

Read: `src/server.ts` (grep で `apiFeatures` を含む行を検索)

**Step 2: 配列に pipelineReportApiModule を追加**

```ts
const apiFeatures: ApiFeatureModule[] = [
  reviewApiModule,
  pipelineReportApiModule,
];
```

**Step 3: 必要な deps を context に注入**

`reviewHandlerDeps` と並列して `pipelineReportHandlerDeps` を追加し、両方 context に注入する middleware を追加。

**Step 4: 既存の `src/presentation/api/__tests__/featureRegistration.test.ts` を更新**

pipeline-report モジュールが登録されていることを検証する期待値を追加。

**Step 5: テスト → コミット**

```bash
git commit -m "feat: serverにpipeline-report機能を登録"
```

---

## Phase 12: Presentation 層 — CLI

### Task 12-1: parsePipelineReportArgs

**Files:**
- Create: `src/cli/pipeline-report/parsePipelineReportArgs.ts`
- Test: `src/cli/pipeline-report/__tests__/parsePipelineReportArgs.test.ts`

参考: `src/cli/review/parseReviewArgs.ts`

設計書 §8.1 のオプション表に沿って実装。必須項目欠落時の例外、CLI オプション優先、環境変数フォールバックを検証。

```bash
git commit -m "feat: pipeline-reportのCLI引数パーサーを追加"
```

### Task 12-2: commandBuilder

**Files:**
- Create: `src/cli/pipeline-report/commandBuilder.ts`
- Test: `src/cli/pipeline-report/__tests__/commandBuilder.test.ts`

参考: `src/cli/review/commandBuilder.ts`

`buildPipelineReportCommand(parsed) → PipelineAnalyzeCommand`（ローカル用）と `buildPipelineReportApiRequest(parsed) → PipelineReportApiRequest`（API 用）。

```bash
git commit -m "feat: pipeline-reportのcommandBuilderを追加"
```

### Task 12-3: pipelineReportCliModule

**Files:**
- Create: `src/cli/pipeline-report/index.ts`
- Test: `src/cli/pipeline-report/__tests__/index.test.ts`

参考: `src/cli/review/index.ts`

主要処理フロー:
1. `parsePipelineReportArgs(args, process.env)`
2. `initializeLogger(...)`
3. 必須項目検証
4. モード判定（AI_API_KEY/URL/MODEL 全て有無）
5. ローカルモード: DI 組み立て → `PipelineAnalysisService.analyze(...)` → 結果を `resultFilePath` + stdout
6. API モード: `PipelineReportApiClient.run(...)` SSE → 結果を `resultFilePath` + stdout
7. 終了コード制御

```bash
git commit -m "feat: pipelineReportCliModuleを追加"
```

### Task 12-4: dispatch.ts への登録

**Files:**
- Modify: `src/cli/dispatch.ts`

`defaultFeatures` に `pipelineReportCliModule` を追加。既存 `src/cli/__tests__/dispatch.test.ts` に pipeline-report サブコマンドの分岐を追加。

```bash
git commit -m "feat: cli/dispatchにpipeline-report機能を登録"
```

---

## Phase 13: Infrastructure 層 — PipelineReportApiClient

### Task 13-1: 実装

**Files:**
- Create: `src/infrastructure/adapter/pipeline-report/apiClient/PipelineReportApiClient.ts`
- Test: `src/infrastructure/adapter/pipeline-report/apiClient/__tests__/PipelineReportApiClient.test.ts`

参考: `src/infrastructure/adapter/review/apiClient/ReviewApiClient.ts`

`POST /api/v1/pipeline-report` に対して fetch + ReadableStream で SSE パース。進捗イベントを `onProgress` コールバックに流し、`result` イベントの内容を返す。

```bash
git commit -m "feat: pipelineReportApiClientを追加"
```

---

## Phase 14: CI テンプレートと環境変数

### Task 14-1: .env.example

**Files:**
- Modify: `.env.example`

**Step 1: 既存の `.env.example` を読む**

Read: `.env.example`

**Step 2: pipeline-report セクションを追加**

既存の review セクションの下に追加:
```
# --- pipeline-report feature ---
# PIPELINE_REPORT_SETTINGS_PATH=
# PIPELINE_REPORT_RESULT_FILE=./aikata-pipeline-report.md
# PIPELINE_REPORT_MAX_ARTIFACT_ZIP_MB=50
# PIPELINE_REPORT_TOTAL_ARTIFACT_DISK_MB=500
# PIPELINE_REPORT_MAX_ARTIFACT_FILE_BYTES=2097152
# PIPELINE_REPORT_MAX_COMPLETENESS_RETRIES=3
# GITLAB_PIPELINE_ID=
# GITLAB_SELF_JOB_ID=
```

**Step 3: コミット**

```bash
git add .env.example
git commit -m "docs: .env.exampleにpipeline-report機能の変数を追加"
```

### Task 14-2: .ci-template/variable/pipeline-report.yml

**Files:**
- Create: `.ci-template/variable/pipeline-report.yml`
- Modify: `.ci-template/variable/variables.yml`

pipeline-report.yml:
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

variables.yml（ファサード）に include を追加:
```yaml
include:
  - local: '.ci-template/variable/shared.yml'
  - local: '.ci-template/variable/review.yml'
  - local: '.ci-template/variable/pipeline-report.yml'
```

```bash
git commit -m "feat: pipeline-report CI変数ファイルを追加"
```

### Task 14-3: .ci-template/pipelines/pipeline-report/template.yml

**Files:**
- Create: `.ci-template/pipelines/pipeline-report/template.yml`
- Create: `.ci-template/pipelines/pipeline-report/template-npx.yml`

設計書 §8.4 の YAML をそのまま記述。Docker 方式と npx 方式の 2 ファイル。

```bash
git commit -m "feat: pipeline-report CIテンプレートを追加"
```

---

## Phase 15: ドキュメント

### Task 15-1: domain ドキュメント

**Files:**
- Create: `docs/domain/pipeline-report/entity.md`
- Create: `docs/domain/pipeline-report/business_rule.md`
- Create: `docs/domain/pipeline-report/usecase.md`
- Create: `docs/domain/pipeline-report/glossary.md`

review の対応ドキュメント（`docs/domain/review/*.md`）と同じ粒度で記述する。business_rule.md には設計書 §4.2, §7.3 (圧縮)、完成判定ループ、AI 総合評価ラベル、GitLab v16 制約を含める。

```bash
git commit -m "docs: pipeline-reportのdomainドキュメントを追加"
```

### Task 15-2: 処理フロー概念設計

**Files:**
- Create: `docs/archtecture/pipeline-report/overallflow_concept.md`

CLI → Service → Workflow → Agent → Tool の流れ、ローカル/API モードの差分、データの流れを図解（ASCII or Mermaid）。

```bash
git commit -m "docs: pipeline-reportの処理フロー概念設計を追加"
```

### Task 15-3: 横断ドキュメント更新

**Files:**
- Modify: `docs/archtecture/tech.md`
- Modify: `docs/archtecture/folder_structure.md`
- Modify: `docs/archtecture/feature-extension.md`
- Modify: `docs/config/env_val.md`
- Modify: `docs/domain/glossary.md`
- Modify: `AGENTS.md`

各ドキュメントに pipeline-report への参照・変数・CLI サブコマンドを追加。

```bash
git commit -m "docs: 横断ドキュメントにpipeline-report機能を反映"
```

---

## Phase 16: エンドツーエンドテスト

### Task 16-1: パラメータ伝播テスト

**Files:**
- Create: `src/__tests__/pipelineReportParameterPropagation.test.ts`

review の対応するテスト（あれば）を参考に、以下の鎖で値が伝播することを検証:

CLI args → parsePipelineReportArgs → commandBuilder → PipelineAnalysisService → workflow params → pipelineAnalysisAgent request context

検証対象:
- `jobReportFormat`
- `additionalInstructions`
- `includeJobPatterns` / `excludeJobPatterns`
- `commentLanguage`
- `maxContextLength`
- `maxCompletenessRetries`
- `skillsPaths`

fake 依存で workflow runner の入力スキーマに流れる値を assert する。

```bash
git commit -m "test: pipeline-reportのパラメータ伝播テストを追加"
```

---

## Phase 17: 最終検証とPBI更新

### Task 17-1: 全テストグリーン確認

**Step 1:**
```bash
npm run test
```
Expected: 全テスト pass

**Step 2:**
```bash
npm run lint
```
Expected: エラーなし

**Step 3:**
```bash
npm run build:cli
```
Expected: バンドル成功

**Step 4: ビルド済み CLI の起動確認（スモーク）**

```bash
node dist/index.js --help 2>&1 || true
node dist/index.js pipeline-report --help 2>&1 || true
```
Expected: help がサブコマンド付きで出力される、pipeline-report サブコマンドが認識される

**Step 5: TypeScript 型エラー確認**

```bash
npx tsc --noEmit
```
Expected: エラーなし（もしくは既存エラーのみ）

### Task 17-2: カバレッジ確認

**Step 1:**
```bash
npm run test:coverage
```
Expected: pipeline-report 関連モジュールの条件カバレッジ 80% 以上

**Step 2: カバレッジ不足箇所のテスト追加**

もし不足があれば該当モジュールの `__tests__/` にテストを追加し、コミット:
```bash
git commit -m "test: pipeline-reportのカバレッジ不足箇所を補強"
```

### Task 17-3: PBI.md 更新

**Files:**
- Modify: `PBI.md`

**Step 1: `PBI.md` を読んで ID:1 のステータス行を `to do` → `in progress` に変更**

ステータス行がない場合は追加。

```bash
git add PBI.md
git commit -m "docs: PBI1のステータスをin progressに変更"
```

### Task 17-4: 最終全テスト実行

```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てグリーン

---

## 完了条件チェックリスト

- [ ] `src/domain/pipeline-report/` 配下のエンティティと単体テスト
- [ ] `src/application/pipeline-report/` 配下の Service・ヘルパーと単体テスト
- [ ] `src/application/shared/port/gateway/PipelineGateway.ts` ポート
- [ ] `src/application/shared/port/workflow/PipelineAnalysisWorkflowRunner.ts` ポート
- [ ] `src/application/shared/parser/parsePipelineReportSettings.ts` とテスト
- [ ] `src/mastra/pipeline-report/` 配下の agents / tools / workflows / steps と単体テスト
- [ ] `src/mastra/shared/readImageCommon.ts` への共通化 (review の動作不変)
- [ ] `src/mastra/index.ts` への登録
- [ ] `src/infrastructure/adapter/pipeline-report/` 配下の gateway / apiClient / workflow と単体テスト
- [ ] `src/presentation/api/pipeline-report/` 配下のハンドラ・ルート・モジュールと単体テスト
- [ ] `src/server.ts` への登録 + `featureRegistration.test.ts` 更新
- [ ] `src/cli/pipeline-report/` 配下の CLI モジュールと単体テスト
- [ ] `src/cli/dispatch.ts` への登録 + `dispatch.test.ts` 更新
- [ ] `src/__tests__/pipelineReportParameterPropagation.test.ts`
- [ ] `.ci-template/pipelines/pipeline-report/template.yml` + `template-npx.yml`
- [ ] `.ci-template/variable/pipeline-report.yml` + `variables.yml` ファサード更新
- [ ] `.env.example` 更新
- [ ] `docs/domain/pipeline-report/{entity,business_rule,usecase,glossary}.md`
- [ ] `docs/archtecture/pipeline-report/overallflow_concept.md`
- [ ] `docs/archtecture/tech.md`, `docs/archtecture/folder_structure.md`, `docs/archtecture/feature-extension.md`, `docs/config/env_val.md`, `docs/domain/glossary.md`, `AGENTS.md` 更新
- [ ] `PBI.md` ID:1 のステータスを `in progress` に変更
- [ ] `npm run test && npm run lint && npm run build:cli` が全てグリーン
- [ ] カバレッジ 80% 以上（条件カバレッジ）
- [ ] review 機能の既存テストが変更前と同じ状態

---

## 参考: タスクごとのファイル一覧早見表

| Task | 主な Create | 主な Modify |
| --- | --- | --- |
| 1-1〜1-7 | `src/domain/pipeline-report/**` | - |
| 2-1〜2-3 | `src/application/shared/port/**`, `src/application/shared/parser/**`, `defaultReportFormat.ts` | - |
| 3-1〜3-6 | `JobLogCompressor`, `ArtifactArchiveReader`, `ArtifactCacheManager`, yauzl 依存, テスト用 zip フィクスチャ | `package.json` |
| 4-1〜4-3 | `pipelineContextBuilder`, `PipelineAnalysisService` | - |
| 5-1〜5-2 | `GitLabPipelineGateway` | - |
| 6-1〜6-2 | `readImageCommon`, `requestContext`, `types` | `src/mastra/review/tools/readImage.ts` |
| 7-1〜7-6 | tools (write/patch/get/getJobLogDetail/getArtifactContent) | - |
| 8-1〜8-4 | agents (analysis/judge/summarization) | - |
| 9-1〜9-6 | workflow, steps | `src/mastra/index.ts` |
| 10-1 | `MastraPipelineAnalysisWorkflowRunner` | - |
| 11-1〜11-4 | API handler/route/module | `src/server.ts`, `featureRegistration.test.ts` |
| 12-1〜12-4 | CLI parser/command/module | `src/cli/dispatch.ts`, `dispatch.test.ts` |
| 13-1 | `PipelineReportApiClient` | - |
| 14-1〜14-3 | CI テンプレート、変数 YAML | `.env.example`, `variables.yml` |
| 15-1〜15-3 | domain/architecture docs | tech.md, folder_structure.md 他 |
| 16-1 | パラメータ伝播テスト | - |
| 17-1〜17-4 | - | `PBI.md` |

---

以上。実装者は Phase 0 の Task 0-1 から順に実行すること。各タスクの Step 5 に到達した時点で Task 完了、次 Task へ。
