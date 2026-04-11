# PBI1 プロジェクト再編 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AIレビュー以外の将来機能を追加しやすくするため、ソース・CIテンプレート・ドキュメントを「機能プラグイン」構造に再編する（振る舞いは不変）。

**Architecture:** レイヤーファースト構造を維持しつつ、各層に `shared/` と `<feature>/` サブフォルダを導入。CLIはサブコマンド方式（`aikata-pr review`）、APIはfeatureモジュール配列でルートをloop登録する。CIテンプレートは `pipelines/review/` に実体、既存パスはファサード。

**Tech Stack:** TypeScript / Mastra / Hono / esbuild / Vitest / GitLab CI

**設計書:** `docs/plans/2026-04-11-pbi1-project-restructure-design.md`

---

## 前提・共通ルール

### 各タスク完了時の検証コマンド
```bash
npm run test
npm run lint
npm run build:cli
```
**3つ全てグリーンでなければ次タスクに進まない。**

### コミットメッセージ規約
- 本プロジェクトはcommitlint（conventional-commits）を使用
- subjectは小文字開始、`type: ` プレフィックス必須
- 日本語OK
- 例: `refactor: ドメイン層をreviewサブフォルダへ移動`

### リネーム検出のため
- ファイル移動は `git mv` を使う
- 同一コミット内に「移動」と「importパス更新」を両方含める（中間状態でビルドが壊れないように）
- 「ついでのリファクタ」は絶対にしない。内容の意味変更を禁止

### importパス一括置換の原則
- 機械的な相対パス調整のみ許容
- エイリアス追加・型再配置・定義変更は禁止
- ESMの `.js` 拡張子を維持

---

## Task 0: 作業ブランチ確認と設計書の再読込

**Step 1: 現在のブランチと状態を確認**

Run:
```bash
git status
git branch --show-current
```
Expected: ワーキングツリーはクリーン（またはPBI.mdの軽微な変更のみ）。ブランチは `develop`。

**Step 2: 設計書を開いて全体像を頭に入れる**

Read: `docs/plans/2026-04-11-pbi1-project-restructure-design.md`

**Step 3: 初期テスト全通過を確認（ベースライン）**

Run:
```bash
npm run test
npm run lint
npm run build:cli
```
Expected: 全てパス。もし既存で失敗しているものがあれば、それを本PBIで直そうとしない（既存エラーは対応不要、AGENTS.md方針）。ただし失敗テスト名をメモし、「移動後に同じ失敗のみ」であることを後で確認できるようにする。

---

## Task 1: 新レイアウトのスケルトンディレクトリ作成

**目的:** 後続タスクで `git mv` した時に移動先パスが既に存在する状態にする。

**Files (create, with `.gitkeep`):**
- `src/domain/shared/.gitkeep`
- `src/domain/review/.gitkeep`
- `src/application/review/.gitkeep`
- `src/mastra/shared/.gitkeep`
- `src/mastra/review/.gitkeep`
- `src/infrastructure/adapter/review/.gitkeep`
- `src/infrastructure/adapter/review/gateway/.gitkeep`
- `src/infrastructure/adapter/review/apiClient/.gitkeep`
- `src/infrastructure/adapter/review/workflow/.gitkeep`
- `src/presentation/api/shared/.gitkeep`
- `src/presentation/api/review/.gitkeep`
- `src/cli/.gitkeep`
- `src/cli/shared/.gitkeep`
- `src/cli/review/.gitkeep`

**Step 1: ディレクトリ作成**

Run:
```bash
mkdir -p src/domain/shared src/domain/review \
  src/application/review \
  src/mastra/shared src/mastra/review \
  src/infrastructure/adapter/review/gateway \
  src/infrastructure/adapter/review/apiClient \
  src/infrastructure/adapter/review/workflow \
  src/presentation/api/shared src/presentation/api/review \
  src/cli/shared src/cli/review
```

**Step 2: `.gitkeep` を各ディレクトリに置く**

Run:
```bash
touch src/domain/shared/.gitkeep src/domain/review/.gitkeep \
  src/application/review/.gitkeep \
  src/mastra/shared/.gitkeep src/mastra/review/.gitkeep \
  src/infrastructure/adapter/review/.gitkeep \
  src/infrastructure/adapter/review/gateway/.gitkeep \
  src/infrastructure/adapter/review/apiClient/.gitkeep \
  src/infrastructure/adapter/review/workflow/.gitkeep \
  src/presentation/api/shared/.gitkeep src/presentation/api/review/.gitkeep \
  src/cli/.gitkeep src/cli/shared/.gitkeep src/cli/review/.gitkeep
```

**Step 3: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: ベースラインと同じ状態でパス。

**Step 4: コミット**

Run:
```bash
git add src/
git commit -m "chore: 再編用スケルトンディレクトリを追加"
```

---

## Task 2: ドメイン層を `src/domain/review/` へ移動

**対象ファイル:**
```
src/domain/checkItem/       → src/domain/review/checkItem/
src/domain/checklist/       → src/domain/review/checklist/
src/domain/mrContext/       → src/domain/review/mrContext/
src/domain/qualityGate/     → src/domain/review/qualityGate/
src/domain/rating/          → src/domain/review/rating/
src/domain/reviewResult/    → src/domain/review/reviewResult/
src/domain/reviewSettings/  → src/domain/review/reviewSettings/
```

**Step 1: `git mv` で7ディレクトリを移動**

Run:
```bash
git mv src/domain/checkItem src/domain/review/checkItem
git mv src/domain/checklist src/domain/review/checklist
git mv src/domain/mrContext src/domain/review/mrContext
git mv src/domain/qualityGate src/domain/review/qualityGate
git mv src/domain/rating src/domain/review/rating
git mv src/domain/reviewResult src/domain/review/reviewResult
git mv src/domain/reviewSettings src/domain/review/reviewSettings
```

**Step 2: importパスを一括更新**

全 `.ts` ファイル内の `from '.*domain/(checkItem|checklist|mrContext|qualityGate|rating|reviewResult|reviewSettings)` を `from '.../domain/review/$1` へ調整する。

**Grep で影響範囲を確認:**

Use Grep:
- pattern: `domain/(checkItem|checklist|mrContext|qualityGate|rating|reviewResult|reviewSettings)`
- type: ts
- output_mode: files_with_matches

**影響ファイルを全て開き、相対パスの階層を計算しながら Edit で置換する。**
- 置換前: `from '../../domain/checkItem/index.js'`
- 置換後: `from '../../domain/review/checkItem/index.js'`

※相対パス階層は元ファイルの位置により異なるため、各ファイルごとに正しい階層数を確認すること。

**Step 3: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス（ベースラインと同じ）。

**Step 4: コミット**

Run:
```bash
git add -A
git commit -m "refactor: ドメイン層をreviewサブフォルダへ移動"
```

---

## Task 3: アプリケーション層の review 固有サービスを移動

**対象ファイル:**
```
src/application/reviewExecution/  → src/application/review/reviewExecution/
src/application/commentPosting/   → src/application/review/commentPosting/
```
`src/application/shared/` は変更しない（parser/comment/prompt/port/diffCompression はそのまま）。

**Step 1: `git mv` で2ディレクトリ移動**

Run:
```bash
git mv src/application/reviewExecution src/application/review/reviewExecution
git mv src/application/commentPosting src/application/review/commentPosting
```

**Step 2: importパス更新**

Use Grep:
- pattern: `application/(reviewExecution|commentPosting)`
- type: ts
- output_mode: files_with_matches

各ファイルで `application/reviewExecution` → `application/review/reviewExecution`、`application/commentPosting` → `application/review/commentPosting` に置換。相対パスの階層を正しく計算すること。

**Step 3: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。

**Step 4: コミット**

Run:
```bash
git add -A
git commit -m "refactor: アプリケーション層のreviewサービスをreviewサブフォルダへ移動"
```

---

## Task 4: Mastra層の review 部分を移動、requestContext を shared へ

**対象ファイル:**
```
src/mastra/agents/               → src/mastra/review/agents/
src/mastra/tools/                → src/mastra/review/tools/
src/mastra/workflows/            → src/mastra/review/workflows/
src/mastra/indexedCheckItem.ts   → src/mastra/review/indexedCheckItem.ts
src/mastra/types.ts              → src/mastra/review/types.ts
src/mastra/requestContext.ts     → src/mastra/shared/requestContext.ts
```

**Step 1: `git mv`**

Run:
```bash
git mv src/mastra/agents src/mastra/review/agents
git mv src/mastra/tools src/mastra/review/tools
git mv src/mastra/workflows src/mastra/review/workflows
git mv src/mastra/indexedCheckItem.ts src/mastra/review/indexedCheckItem.ts
git mv src/mastra/types.ts src/mastra/review/types.ts
git mv src/mastra/requestContext.ts src/mastra/shared/requestContext.ts
```

**Step 2: `src/mastra/index.ts` のimport先を更新**

Edit: `src/mastra/index.ts`

置換前:
```ts
import { reviewWorkflow } from './workflows/index.js';
import { reviewAgent } from './agents/reviewAgent.js';
import { checklistSplitAgent } from './agents/checklistSplitAgent.js';
import { summarizationAgent } from './agents/summarizationAgent.js';
```

置換後:
```ts
import { reviewWorkflow } from './review/workflows/index.js';
import { reviewAgent } from './review/agents/reviewAgent.js';
import { checklistSplitAgent } from './review/agents/checklistSplitAgent.js';
import { summarizationAgent } from './review/agents/summarizationAgent.js';
```

**Step 3: その他Mastra内部相対importを調整**

Use Grep:
- pattern: `from '(\.\./)+mastra/(agents|tools|workflows|indexedCheckItem|types|requestContext)`
- type: ts
- output_mode: files_with_matches

移動したファイル同士の内部参照（例: `agents/reviewAgent.ts` から `../tools/index.js`）は相対的には変わらないため、主にパス内の `/mastra/` セグメントを扱う外部参照を調整する。

具体的には:
- `requestContext` を参照するファイル（mastra配下の複数 + ルート src 層）を `shared/requestContext.js` に向ける
- `indexedCheckItem`, `types` を参照するファイル（mastra配下）を `../indexedCheckItem.js` → `./indexedCheckItem.js` 等に調整（agents/tools/workflowsがreview配下に入ったため、相対の基準が変わる）

**Grep で抜け漏れを確認:**

Use Grep:
- pattern: `from ['"]([./]+)(mastra|\.\./)*(agents|tools|workflows|indexedCheckItem|types|requestContext)`
- type: ts
- output_mode: content
- -n: true

**Step 4: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。Mastraワークフローテスト (`src/mastra/**/__tests__/**`) が全て通ること。

**Step 5: コミット**

Run:
```bash
git add -A
git commit -m "refactor: mastra層をreview/shared構成へ再編"
```

---

## Task 5: インフラ層の review 固有アダプタを移動

**対象ファイル:**
```
src/infrastructure/adapter/gateway/GitLabMrDiscussionGateway.ts
  → src/infrastructure/adapter/review/gateway/GitLabMrDiscussionGateway.ts
src/infrastructure/adapter/apiClient/
  → src/infrastructure/adapter/review/apiClient/
src/infrastructure/adapter/workflow/
  → src/infrastructure/adapter/review/workflow/
```

**注意:** `gateway/index.ts` (gateway/のバレルexport) は `GitLabMrDiscussionGateway` を再exportしている可能性が高いので、移動後に削除または更新すること。

**Step 1: `gateway/index.ts` を確認**

Read: `src/infrastructure/adapter/gateway/index.ts`

`GitLabMrDiscussionGateway` のexport行を特定する。

**Step 2: `git mv`**

Run:
```bash
git mv src/infrastructure/adapter/gateway/GitLabMrDiscussionGateway.ts \
       src/infrastructure/adapter/review/gateway/GitLabMrDiscussionGateway.ts
git mv src/infrastructure/adapter/apiClient src/infrastructure/adapter/review/apiClient
git mv src/infrastructure/adapter/workflow src/infrastructure/adapter/review/workflow
```

**Step 3: `gateway/index.ts` から `GitLabMrDiscussionGateway` のexport行を削除**

Edit: `src/infrastructure/adapter/gateway/index.ts`
該当行を削除。`gateway/__tests__/` にあるDiscussionGatewayテストがあれば、そのテストファイルも review/gateway 側に移動することを検討（同一ファイル名のテストを同じ場所に置く原則）。

Use Grep:
- pattern: `GitLabMrDiscussionGateway`
- type: ts
- output_mode: files_with_matches

**Step 4: `review/gateway/index.ts` を新規作成**

Write: `src/infrastructure/adapter/review/gateway/index.ts`
```ts
export { GitLabMrDiscussionGateway } from './GitLabMrDiscussionGateway.js';
```

**Step 5: import先を更新**

全ての `GitLabMrDiscussionGateway` インポートを `infrastructure/adapter/review/gateway` 経由に変更。
`ReviewApiClient` インポートを `infrastructure/adapter/review/apiClient` 経由に変更。
`MastraReviewWorkflowRunner` インポートを `infrastructure/adapter/review/workflow` 経由に変更。

Use Grep:
- pattern: `adapter/(apiClient|workflow)`
- type: ts
- output_mode: files_with_matches

Use Grep:
- pattern: `GitLabMrDiscussionGateway|ReviewApiClient|MastraReviewWorkflowRunner`
- type: ts
- output_mode: files_with_matches

**Step 6: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。

**Step 7: コミット**

Run:
```bash
git add -A
git commit -m "refactor: インフラ層のreview固有アダプタをreviewサブフォルダへ移動"
```

---

## Task 6: プレゼンテーション層を shared / review に分割

**対象ファイル:**
```
src/presentation/api/requestIdMiddleware.ts  → src/presentation/api/shared/requestIdMiddleware.ts
src/presentation/api/reviewRoute.ts          → src/presentation/api/review/reviewRoute.ts
src/presentation/api/reviewHandler.ts        → src/presentation/api/review/reviewHandler.ts
```

**Step 1: `git mv`**

Run:
```bash
git mv src/presentation/api/requestIdMiddleware.ts src/presentation/api/shared/requestIdMiddleware.ts
git mv src/presentation/api/reviewRoute.ts src/presentation/api/review/reviewRoute.ts
git mv src/presentation/api/reviewHandler.ts src/presentation/api/review/reviewHandler.ts
```

**Step 2: `src/presentation/api/index.ts` を2つのindexに分割**

元 `src/presentation/api/index.ts` の内容を以下に分割:

Write: `src/presentation/api/shared/index.ts`
```ts
export { createRequestIdMiddleware, REQUEST_ID_HEADER } from './requestIdMiddleware.js';
export type { RequestIdEnv } from './requestIdMiddleware.js';
```

Write: `src/presentation/api/review/index.ts`
```ts
export { createReviewRoute } from './reviewRoute.js';
export type { ReviewRouteEnv } from './reviewRoute.js';
export {
  createReviewHandler,
  reviewRequestSchema,
  buildReviewSettings,
  DefaultPerRequestServiceFactory,
} from './reviewHandler.js';
export type {
  ReviewRequest,
  ReviewHandlerDeps,
  SSEEvent,
  PerRequestServiceFactory,
  MrInfoFetcher,
  ReviewExecutor,
} from './reviewHandler.js';
```

Edit: `src/presentation/api/index.ts`
既存内容を全て削除し、以下の再export（後方互換ではなく、`server.ts` が現状 `./presentation/api/index.js` から全部importしているので、それを壊さないために維持）:
```ts
export * from './shared/index.js';
export * from './review/index.js';
```

**注意:** 本当に `index.ts` 再export層が必要か確認する。`src/server.ts` が `./presentation/api/index.js` から取得しているものは `reviewRoute`, `reviewHandler`, `requestIdMiddleware` 等。今回の再編では `server.ts` は後続Task 10で書き換えるため、**中間状態として** `index.ts` の再export集約層を一時的に維持するのが安全。

**Step 3: 内部相対importの調整**

移動先ファイル内の相対パスを更新:
- `reviewRoute.ts` の `./reviewHandler.js` → `./reviewHandler.js`（同ディレクトリなので不変）
- `reviewHandler.ts` の `../../application/...` → `../../../application/...`（階層が1段深くなった）
- `reviewHandler.ts` の `../../infrastructure/...` → `../../../infrastructure/...`
- `reviewHandler.ts` の `../../domain/...` → `../../../domain/review/...`（Task2でdomain/reviewに移動済なのでこれも反映）
- `reviewHandler.ts` の `../../lib/logger.js` → `../../../lib/logger.js`
- `requestIdMiddleware.ts` の内部import（あれば同様に1段深くする）

**Step 4: 外部から参照しているimportパスを確認**

Use Grep:
- pattern: `presentation/api/(reviewRoute|reviewHandler|requestIdMiddleware)`
- type: ts
- output_mode: files_with_matches

これらは `index.ts` 経由アクセスに置き換えるか、新パスに直接向ける（好ましいのは後者）。
`src/server.ts` からの参照は Task 10 で整理するので、この時点では `index.ts` 経由で吸収しておく。

**Step 5: テスト側importパスも同時に更新**

Use Grep:
- pattern: `from .*presentation/api/(reviewRoute|reviewHandler|requestIdMiddleware)`
- type: ts
- output_mode: files_with_matches

テストファイル（`src/presentation/api/__tests__/*.test.ts`）の相対importを新パスに合わせて調整。

**Step 6: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。

**Step 7: コミット**

Run:
```bash
git add -A
git commit -m "refactor: presentation/apiをshared/review構成へ分割"
```

---

## Task 7: CLI 層を分割し、reviewCliModule を導入する（サブコマンド未接続）

**目的:** 旧 `src/index.ts` の `main()` 本体を `src/cli/review/index.ts` の `run(args, env)` として移動し、`reviewCliModule` を定義する。dispatcher化は次Taskで行うため、このTaskでは**まず `src/index.ts` がこの新モジュールの `run()` を呼ぶだけの状態**に保つ。

**Step 1: `src/lib/cli.ts` と `src/lib/commandBuilder.ts` を review 側に移動**

Run:
```bash
git mv src/lib/cli.ts src/cli/review/parseReviewArgs.ts
git mv src/lib/commandBuilder.ts src/cli/review/commandBuilder.ts
git mv src/lib/__tests__/cli.test.ts src/cli/review/__tests__/parseReviewArgs.test.ts
git mv src/lib/__tests__/commandBuilder.test.ts src/cli/review/__tests__/commandBuilder.test.ts
```

**Step 2: 移動後の相対import更新**

- `parseReviewArgs.ts` の `import type { ChecklistParseOptions } from '../application/shared/parser/index.js'` → `'../../application/shared/parser/index.js'`
- `commandBuilder.ts` の各相対パス（`./cli.js`, `../application/...`, `../domain/...`, `../infrastructure/...`）を新位置から計算し直す
  - `./cli.js` → `./parseReviewArgs.js`
  - `../application/reviewExecution/...` → `../../application/review/reviewExecution/...`
  - `../domain/checklist/...` → `../../domain/review/checklist/...`
  - `../infrastructure/adapter/apiClient/...` → `../../infrastructure/adapter/review/apiClient/...`
- テストファイルの `from '../cli.js'` → `from '../parseReviewArgs.js'` 等

**Step 3: `src/cli/review/index.ts` を作成し `main()` を `run(args, env)` として移す**

Read: `src/index.ts`（既存 `main()` 本体）

Write: `src/cli/review/index.ts`
```ts
// 旧 src/index.ts の main() 本体を run() にリネームして移動。
// 振る舞いは一切変更しないこと。
import { parseCliOptions, buildChecklistParseOptions } from './parseReviewArgs.js';
import { initializeLogger, getLogger, flushLogger, runWithLogContext } from '../../lib/logger.js';
import {
  validateRequiredParams,
  buildApiReviewRequest,
  buildLocalReviewCommand,
  isLocalMode,
} from './commandBuilder.js';
import { ChecklistParser, ReviewSettingsParser } from '../../application/shared/parser/index.js';
import { ReviewExecutionService } from '../../application/review/reviewExecution/index.js';
import { CommentPostingService } from '../../application/review/commentPosting/index.js';
import { ReviewResult } from '../../domain/review/reviewResult/index.js';
import { Rating } from '../../domain/review/rating/index.js';
import { GitLabApiClient } from '../../infrastructure/adapter/httpClient/index.js';
import {
  GitLabMrGateway,
  LocalGitDiffMrGateway,
  LocalProjectTreeGateway,
} from '../../infrastructure/adapter/gateway/index.js';
import { GitLabMrDiscussionGateway } from '../../infrastructure/adapter/review/gateway/index.js';
import { ReviewApiClient } from '../../infrastructure/adapter/review/apiClient/index.js';
import { MastraReviewWorkflowRunner } from '../../infrastructure/adapter/review/workflow/index.js';
import { GptTokenCounter } from '../../infrastructure/adapter/tokenCounter/index.js';
import { ReviewSettings } from '../../domain/review/reviewSettings/index.js';
import { RateLimiter } from '../../infrastructure/adapter/rateLimiter/index.js';
import { initializeRateLimiter, resetRateLimiter } from '../../lib/rateLimiterGlobal.js';
import fs from 'node:fs';

/**
 * reviewサブコマンドのエントリ
 * 旧 src/index.ts の main() を関数化したもの。振る舞いは完全に同一。
 */
export async function run(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  const options = parseCliOptions(args, env as Record<string, string>);

  initializeLogger({
    userId: options.userId ?? 'unknown',
    level: options.logLevel,
    prettyPrint: options.prettyPrint,
  });

  const logger = getLogger();
  logger.info('aikata-pr started');

  let apiRequestId: string | undefined;

  try {
    // ... 旧 main() の try-catch 本体をそのまま移植 ...
    // （省略: 旧実装をファイルから丸ごとコピー）
  } catch (error) {
    // ... 旧catch節をそのまま移植 ...
  }
}

export const reviewCliModule = {
  name: 'review',
  description: 'Run AI review on a GitLab MR',
  run,
};
```

**重要:** 上記の `// ... 省略 ...` 部分は旧 `src/index.ts` の `main()` 関数の中身を**一字一句そのまま**コピーすること。変更禁止。`process.env` 参照が `env` 引数参照に変わっても良いが、ロジックの挙動に影響しないよう注意する。最もシンプルなのは **`process.env` はそのまま残し、`args` だけ引数化する** こと。これなら既存の `cli.test.ts`（旧 `parseCliOptions` 経由）の振る舞いも変わらない。

**実装方針:** `run` は `args: string[]` のみ引数化し、`process.env` は旧実装どおり関数内で参照する。`env` 引数は将来のため存在はするが、内部実装は `process.env` を優先して参照し続ける（後方の変更影響を最小化）。

よって実際のシグネチャ:
```ts
export async function run(args: string[]): Promise<void> {
  // 旧 main() そのまま。parseCliOptions(args, process.env as ...) を使う
}
```

**Step 4: 旧 `src/index.ts` を reviewCliModule を呼ぶだけに薄型化**

Edit: `src/index.ts`

全内容を以下に置換:
```ts
import { run } from './cli/review/index.js';

// 暫定: Task 8 で src/cli.ts のディスパッチャに差し替える
run(process.argv.slice(2));
```

※このTask時点では未だサブコマンド必須化していない。後続Taskでdispatcher化する。

**Step 5: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。`dist/index.js` 経由でも従来と同じ挙動。

**手動スモーク:**
```bash
node dist/index.js --help 2>&1 || true
```
（`--help` は未実装かもしれないが、exitコード1でusage的なエラーが出る等、クラッシュしないことを確認）

**Step 6: コミット**

Run:
```bash
git add -A
git commit -m "refactor: cli実装をsrc/cli/review配下へ移し reviewCliModule を定義"
```

---

## Task 8: サブコマンド・ディスパッチャ `src/cli.ts` を導入

**Step 1: `src/cli.ts` を新規作成**

Write: `src/cli.ts`
```ts
#!/usr/bin/env node
import { reviewCliModule } from './cli/review/index.js';

/**
 * 機能モジュールの配列。将来新機能を追加する際はここに1行追加する。
 */
const features = [reviewCliModule];

function printUsage(): void {
  const lines = [
    'Usage: aikata-pr <command> [options]',
    '',
    'Commands:',
    ...features.map((f) => `  ${f.name.padEnd(12)} ${f.description}`),
  ];
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [subcommand, ...rest] = argv;

  if (!subcommand) {
    printUsage();
    process.exit(1);
  }

  const feature = features.find((f) => f.name === subcommand);
  if (!feature) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${subcommand}`);
    printUsage();
    process.exit(1);
  }

  await feature.run(rest);
}

main();
```

**Step 2: `build.ts` のエントリを差し替える**

Edit: `build.ts`
- `entryPoints: ['src/index.ts']` → `entryPoints: ['src/cli.ts']`
- `outfile: 'dist/index.js'` は**変更しない**（bin互換のため）

**Step 3: 旧 `src/index.ts` を削除**

Run:
```bash
git rm src/index.ts
```

**Step 4: 新規テスト `src/cli/__tests__/dispatch.test.ts` を追加**

Write: `src/cli/__tests__/dispatch.test.ts`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// モック用: reviewCliModule の run を差し替える方式ではなく、
// ディスパッチャの振る舞いを独立して検証するため、
// ここではサブプロセス起動ベースではなく、
// dispatchRun関数として関数化された版を用意する必要がある。
//
// 実装方針: src/cli.ts の main()相当を export するリファクタを行う
// （テスタビリティのため）。

import { dispatch } from '../../cli.js';

describe('cli dispatcher', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('プリントusageして非0終了: サブコマンド無し', async () => {
    await expect(dispatch([], [])).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalled();
    const combined = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('Usage: aikata-pr');
  });

  it('プリントusageして非0終了: 未知サブコマンド', async () => {
    await expect(dispatch(['unknown'], [])).rejects.toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalled();
    const combined = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('Unknown command: unknown');
  });

  it('reviewモジュールを呼び出す', async () => {
    const runMock = vi.fn().mockResolvedValue(undefined);
    const fakeFeatures = [{ name: 'review', description: 'x', run: runMock }];
    await dispatch(['review', '--foo', 'bar'], fakeFeatures);
    expect(runMock).toHaveBeenCalledWith(['--foo', 'bar']);
  });
});
```

**Step 5: テスタビリティのため `src/cli.ts` に `dispatch` 関数をexport**

Edit: `src/cli.ts`

以下のように構造を変更:
```ts
#!/usr/bin/env node
import { reviewCliModule } from './cli/review/index.js';

export interface CliFeatureModule {
  name: string;
  description: string;
  run: (args: string[]) => Promise<void>;
}

const defaultFeatures: CliFeatureModule[] = [reviewCliModule];

function printUsage(features: CliFeatureModule[]): void {
  const lines = [
    'Usage: aikata-pr <command> [options]',
    '',
    'Commands:',
    ...features.map((f) => `  ${f.name.padEnd(12)} ${f.description}`),
  ];
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
}

/**
 * サブコマンドディスパッチャ本体。テスト容易性のためexport。
 * @param argv - process.argv.slice(2) 相当
 * @param features - 登録機能モジュール配列（未指定時はdefaultFeatures）
 */
export async function dispatch(
  argv: string[],
  features: CliFeatureModule[] = defaultFeatures,
): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (!subcommand) {
    printUsage(features);
    process.exit(1);
  }

  const feature = features.find((f) => f.name === subcommand);
  if (!feature) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${subcommand}`);
    printUsage(features);
    process.exit(1);
  }

  await feature.run(rest);
}

// エントリポイント（直接実行時のみ起動、テストimport時は起動しない）
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  dispatch(process.argv.slice(2)).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
```

**注意:** esbuildでバンドルすると `import.meta.url` と `process.argv[1]` の判定が効きづらい場合がある。`build.ts` がESM bundleを出力しているため、`import.meta.url` は利用可能。ただし、実際に `node dist/index.js` で実行時に `dispatch` が呼ばれない状況にならないよう、最終確認として `node dist/index.js review` の挙動を手動で検証する。

**より安全な代替:** `isMainModule` チェックを省略し、ファイル末尾で常に `dispatch(...)` を呼ぶ。ただしテスト時にimportするとdispatchが即実行される問題が生じるため、テスト側では `src/cli.ts` を直接importせず、`dispatch` のみを `import { dispatch } from '../../cli.js';` のようにnamed importする場合でもモジュール評価でdispatchが走ってしまう。

**決定案:** `dispatch` と `main` を別ファイルに分ける。
- `src/cli.ts` はエントリポイント（`#!/usr/bin/env node` 付き）→ `dispatch` を呼ぶだけ
- `src/cli/dispatch.ts` に `dispatch`, `CliFeatureModule`, `defaultFeatures`, `printUsage` を定義
- テストは `src/cli/__tests__/dispatch.test.ts` から `../dispatch.js` を import

**Step 5（修正版）: dispatchロジックを `src/cli/dispatch.ts` に分離**

Write: `src/cli/dispatch.ts`
```ts
import { reviewCliModule } from './review/index.js';

export interface CliFeatureModule {
  name: string;
  description: string;
  run: (args: string[]) => Promise<void>;
}

export const defaultFeatures: CliFeatureModule[] = [reviewCliModule];

export function printUsage(features: CliFeatureModule[]): void {
  const lines = [
    'Usage: aikata-pr <command> [options]',
    '',
    'Commands:',
    ...features.map((f) => `  ${f.name.padEnd(12)} ${f.description}`),
  ];
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
}

export async function dispatch(
  argv: string[],
  features: CliFeatureModule[] = defaultFeatures,
): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (!subcommand) {
    printUsage(features);
    process.exit(1);
  }

  const feature = features.find((f) => f.name === subcommand);
  if (!feature) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${subcommand}`);
    printUsage(features);
    process.exit(1);
  }

  await feature.run(rest);
}
```

Write: `src/cli.ts`
```ts
#!/usr/bin/env node
import { dispatch } from './cli/dispatch.js';

dispatch(process.argv.slice(2)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

**Step 6: テストimportパスを `../dispatch.js` に修正**

Edit: `src/cli/__tests__/dispatch.test.ts`
- `import { dispatch } from '../../cli.js';` → `import { dispatch } from '../dispatch.js';`

**Step 7: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。新規 `dispatch.test.ts` が3ケース全てパス。

**Step 8: 手動スモーク**

Run:
```bash
node dist/index.js 2>&1 | head -20 || true
```
Expected: `Usage: aikata-pr` を含むメッセージ、exit code 1。

```bash
node dist/index.js unknown-cmd 2>&1 | head -20 || true
```
Expected: `Unknown command: unknown-cmd` を含むメッセージ、exit code 1。

**Step 9: コミット**

Run:
```bash
git add -A
git commit -m "feat: aikata-prをサブコマンド方式に変更 (review サブコマンドを追加)"
```

---

## Task 9: API サーバに featureモジュール登録パターンを適用

**Step 1: `src/presentation/api/review/index.ts` に `reviewApiModule` を追加**

Edit: `src/presentation/api/review/index.ts`

既存のexportに追記:
```ts
import type { Hono } from 'hono';
import { createReviewRoute } from './reviewRoute.js';
import type { ReviewHandlerDeps } from './reviewHandler.js';
import type { ReviewRouteEnv } from './reviewRoute.js';
import type { JwtAuthEnv } from '../../../infrastructure/adapter/auth/index.js';
import type { RequestIdEnv } from '../shared/requestIdMiddleware.js';

export interface ApiFeatureModule {
  name: string;
  register: (
    app: Hono<JwtAuthEnv & ReviewRouteEnv & RequestIdEnv>,
    deps: ReviewHandlerDeps,
  ) => void;
}

export const reviewApiModule: ApiFeatureModule = {
  name: 'review',
  register: (app, _deps) => {
    const route = createReviewRoute();
    app.route('/api/v1', route);
  },
};
```

**注意:** 型が `JwtAuthEnv & ReviewRouteEnv & RequestIdEnv` となっているが、将来他機能が追加されるとこのunionは増える。現時点では既存の `createApp` の型定義と一致させるため既存の型を使う。将来的には汎用化するが、本PBIでは不要。

`deps` を実際には使わないなら `_deps` で良いが、将来他機能は受け取る可能性があるので引数は残す。

**注意2:** `reviewHandlerDeps` は現状 `app.use('/api/*', async (c, next) => { c.set('reviewHandlerDeps', deps); ... })` という middleware で注入されているため、`reviewApiModule.register` では route追加のみ行い、deps 注入は `server.ts` の `createApp` 側に残すのが自然。

**Step 2: `src/server.ts` の `createApp` を修正**

Read: `src/server.ts`

現行 `createApp` 内の以下のブロックを置換:
```ts
const reviewRoute = createReviewRoute();
app.route('/api/v1', reviewRoute);
```

↓

```ts
const apiFeatures: ApiFeatureModule[] = [reviewApiModule];
apiFeatures.forEach((f) => f.register(app, deps));
```

import を整理:
- `createReviewRoute` のimportを削除
- `reviewApiModule`, `ApiFeatureModule` を `./presentation/api/review/index.js` からimport

**Step 3: `src/presentation/api/index.ts` のre-export層を整理**

Edit: `src/presentation/api/index.ts`
```ts
export * from './shared/index.js';
export * from './review/index.js';
```

`server.ts` が直接 `./presentation/api/review/index.js` からimportするようになれば、この再export層は不要になるが、他に参照されている可能性を考え、残しておく。

Use Grep:
- pattern: `from .*presentation/api/index`
- type: ts
- output_mode: files_with_matches

`server.ts` 以外で参照があるか確認。無ければ削除可能。

**Step 4: 新規テスト `src/presentation/api/__tests__/featureRegistration.test.ts`**

Write: `src/presentation/api/__tests__/featureRegistration.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { reviewApiModule } from '../review/index.js';
import type { ReviewHandlerDeps } from '../review/index.js';

describe('reviewApiModule', () => {
  it('/api/v1/review ルートを登録する', async () => {
    const app = new Hono();
    // 最低限のdepsモック（registerは実際にはdepsを使わずrouteを登録するだけ）
    const fakeDeps = {} as unknown as ReviewHandlerDeps;
    reviewApiModule.register(app as never, fakeDeps);

    // ダミーPOSTを投げてrouteが存在することを確認（404でないこと）
    const res = await app.request('/api/v1/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // バリデーション失敗 (400) でルートは存在する
    expect(res.status).not.toBe(404);
  });

  it('name が review であること', () => {
    expect(reviewApiModule.name).toBe('review');
  });
});
```

**Step 5: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。新規 `featureRegistration.test.ts` が2ケース全てパス。

**Step 6: コミット**

Run:
```bash
git add -A
git commit -m "feat: apiサーバにfeatureモジュール登録パターンを導入"
```

---

## Task 10: `.vscode/launch.json` の CLI パス更新

**Step 1: 旧 `src/index.ts` 参照を `src/cli.ts` に変更し、`review` サブコマンド引数を追加**

Edit: `.vscode/launch.json`

2箇所の CLI configuration (`Debug CLI (Local)` と `Debug CLI (API)`) の `args` を:
```json
"args": [
  "src/index.ts",
  "--checklist", "${workspaceFolder}/debug/checklist.csv",
  "--review-settings", "${workspaceFolder}/debug/review-settings.json"
]
```
↓
```json
"args": [
  "src/cli.ts",
  "review",
  "--checklist", "${workspaceFolder}/debug/checklist.csv",
  "--review-settings", "${workspaceFolder}/debug/review-settings.json"
]
```

**Step 2: 検証**

launch.jsonは実行時のみ参照されるため `npm run test` では検証されない。JSONとしての構文妥当性のみ確認:

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('.vscode/launch.json', 'utf-8')); console.log('ok')" 2>&1 || true
```
※ launch.jsonはコメント付きJSONCの場合があるため、失敗しても致命ではない。エラー内容を確認する。

**Step 3: コミット**

Run:
```bash
git add .vscode/launch.json
git commit -m "chore: vscode debug configをサブコマンド方式に追随"
```

---

## Task 11: CI テンプレートを review サブディレクトリへ移動しファサードを追加

**Step 1: pipelines ディレクトリを作成し、既存ファイルを review サブディレクトリへ移動**

Run:
```bash
mkdir -p .ci-template/pipelines/review
git mv .ci-template/pipelines/template.yml .ci-template/pipelines/review/template.yml
git mv .ci-template/pipelines/template-npx.yml .ci-template/pipelines/review/template-npx.yml
```

**Step 2: review 実体側の `script:` で `aikata-pr review` を呼び出すよう1行変更**

Edit: `.ci-template/pipelines/review/template.yml`

該当行:
```yaml
- |
  aikata-pr \
    --user-id "${USER_ID}" \
```
↓
```yaml
- |
  aikata-pr review \
    --user-id "${USER_ID}" \
```

Edit: `.ci-template/pipelines/review/template-npx.yml`

該当行:
```yaml
- |
  npx @aikata/aikata-pr@${AIKATA_VERSION} \
    --user-id "${USER_ID}" \
```
↓
```yaml
- |
  npx @aikata/aikata-pr@${AIKATA_VERSION} review \
    --user-id "${USER_ID}" \
```

**Step 3: ファサード用の新規ファイル作成**

Write: `.ci-template/pipelines/template.yml`
```yaml
# .ci-template/pipelines/template.yml
# 後方互換用のファサード。reviewジョブの実体は review/template.yml を参照。
# 既存ユーザはこのファイルをincludeし続けることで変更不要で動作する。
#
# 使い方:
#   include:
#     - project: '<本プロジェクトのパス>'
#       file: '.ci-template/pipelines/template.yml'

include:
  - local: '.ci-template/pipelines/review/template.yml'
```

Write: `.ci-template/pipelines/template-npx.yml`
```yaml
# .ci-template/pipelines/template-npx.yml
# 後方互換用のファサード。review(npx方式)ジョブの実体は review/template-npx.yml を参照。
#
# 使い方:
#   include:
#     - project: '<本プロジェクトのパス>'
#       file: '.ci-template/pipelines/template-npx.yml'

include:
  - local: '.ci-template/pipelines/review/template-npx.yml'
```

**Step 4: 検証（YAML構文）**

Run:
```bash
node -e "const yaml = require('js-yaml'); ['./.ci-template/pipelines/template.yml','./.ci-template/pipelines/template-npx.yml','./.ci-template/pipelines/review/template.yml','./.ci-template/pipelines/review/template-npx.yml'].forEach(p => { try { yaml.load(require('fs').readFileSync(p,'utf-8')); console.log('ok:',p); } catch(e) { console.error('err:',p,e.message); process.exit(1); } })" 2>&1 || true
```
※ `js-yaml` が未導入の場合はスキップ。その場合は目視確認。

**Step 5: 本プロジェクトの `.gitlab-ci.yml` に影響がないか確認**

Read: `.gitlab-ci.yml`

`.ci-template/pipelines/template.yml` や `template-npx.yml` を参照していないか、参照していてもファサード経由で動作するか確認。影響があれば最小限の修正。

**Step 6: コミット**

Run:
```bash
git add -A
git commit -m "refactor: ci/pipelines をreviewサブディレクトリ化し既存パスをファサードに"
```

---

## Task 12: CI 変数ファイルの分割とファサード

**Step 1: 新規ファイル作成**

Write: `.ci-template/variable/shared.yml`
```yaml
# 全機能共通のCI変数デフォルト値
variables:
  # GitLab
  GITLAB_API_URL: ""
  AIKATA_PR_GITLAB_TOKEN: ""
  GITLAB_PROJECT_ID: "$CI_PROJECT_ID"
  # AI共通
  AI_API_KEY: ""
  AI_API_ENDPOINT_URL: ""
  AI_MODEL_NAME: ""
  OPENAI_REASONING_EFFORT: ""
  # Feature Toggle
  AIKATA_PR_DISABLED: "false"
  # Settings
  USER_ID: "$GITLAB_USER_LOGIN"
  AIKATA_LOG_LEVEL: "info"
  # API Mode (AI_API_KEY, AI_API_ENDPOINT_URL, AI_MODEL_NAMEが全て未設定時に必要)
  AIKATA_API_URL: ""
  # Container Image（Docker方式用）
  AIKATA_IMAGE: ""
  AIKATA_IMAGE_TAG: "latest"
  # npm（npx方式用）
  AIKATA_PROJECT_ID: ""
  AIKATA_VERSION: "latest"
  # Context Length（AI全般で使う可能性）
  MAX_CONTEXT_LENGTH: ""
```

Write: `.ci-template/variable/review.yml`
```yaml
# review機能固有のCI変数デフォルト値
variables:
  GITLAB_MR_IID: "$CI_MERGE_REQUEST_IID"
  # Input
  CHECKLIST_PATH: ""
  CHECKLIST_COLUMNS: ""
  CHECKLIST_NO_HEADER: "false"
  REVIEW_SETTINGS_PATH: ""
  SKILLS_PATH: ""
  # レビュー出力設定
  COMMENT_LANGUAGE: "Japanese"
  # ツリー表示
  TREE_MAX_DEPTH: ""
```

**Step 2: 既存 `variables.yml` をファサード化**

Edit: `.ci-template/variable/variables.yml`

既存内容を全て削除し、以下に置換:
```yaml
# 後方互換用のファサード。
# 全機能共通変数(shared.yml) と review固有変数(review.yml) をinclude する。
include:
  - local: '.ci-template/variable/shared.yml'
  - local: '.ci-template/variable/review.yml'
```

**Step 3: ネスト include がGitLab CIで動作する前提を文書で確認**

GitLab CIは `include` のネストをサポート（`.ci-template/pipelines/review/template.yml` が `.ci-template/variable/variables.yml` をincludeし、その `variables.yml` がさらに `shared.yml` と `review.yml` をincludeする形）。ネスト深度の上限（GitLabドキュメントで通常150以上）を大きく下回るため問題なし。

**Step 4: 検証（YAML構文）**

Run（目視確認でもよい）:
```bash
node -e "const yaml = require('js-yaml'); ['./.ci-template/variable/variables.yml','./.ci-template/variable/shared.yml','./.ci-template/variable/review.yml'].forEach(p => { try { yaml.load(require('fs').readFileSync(p,'utf-8')); console.log('ok:',p); } catch(e) { console.error('err:',p); process.exit(1); } })" 2>&1 || true
```

**Step 5: コミット**

Run:
```bash
git add -A
git commit -m "refactor: ci variables を shared/review に分割し variables.yml をファサード化"
```

---

## Task 13: docs の機能別分割

**Step 1: `docs/domain/` の機能別分離**

Read: `docs/domain/entity.md`, `docs/domain/business_rule.md`, `docs/domain/usecase.md`, `docs/domain/glossary.md`

各文書の内容のうち、**review固有の部分**と**横断的な部分**を目視で区別する。
基本的に現在の4文書は全てreview前提で書かれているため、以下の方針で分割:

1. `docs/domain/review/` を新規作成
2. `docs/domain/entity.md` → `docs/domain/review/entity.md`
3. `docs/domain/business_rule.md` → `docs/domain/review/business_rule.md`
4. `docs/domain/usecase.md` → `docs/domain/review/usecase.md`
5. `docs/domain/glossary.md` はreview用語（チェックリスト、チェック項目、レビュー結果、品質ゲート、レビュー設定）を `docs/domain/review/glossary.md` にコピー。`docs/domain/glossary.md` には**横断的に使える用語のみ残す**（現状は全てreview固有なので、`docs/domain/glossary.md` は「このファイルは全機能横断の用語のみを記載する。機能固有の用語は `docs/domain/<feature>/glossary.md` を参照」という案内のみに置き換える）

Run:
```bash
mkdir -p docs/domain/review
git mv docs/domain/entity.md docs/domain/review/entity.md
git mv docs/domain/business_rule.md docs/domain/review/business_rule.md
git mv docs/domain/usecase.md docs/domain/review/usecase.md
cp docs/domain/glossary.md docs/domain/review/glossary.md
```

※ `glossary.md` は `cp` してから元ファイルを書き換える。`git mv` ではなく「元にコピーを残す」必要があるため。

**Step 2: 横断 `docs/domain/glossary.md` の内容を刷新**

Edit: `docs/domain/glossary.md`

既存内容を全て削除し、以下に置換:
```markdown
# 用語集（全機能横断）

このファイルは全機能で横断的に使える用語のみを記載する。
機能固有の用語は各機能配下の glossary を参照:

- review: `docs/domain/review/glossary.md`

## 横断用語

（現時点では横断用語は無し。将来必要に応じて追記）
```

**Step 3: `docs/archtecture/folder_structure.md` を新レイアウトに更新**

Edit: `docs/archtecture/folder_structure.md`

全面的に書き換え。設計書 (`docs/plans/2026-04-11-pbi1-project-restructure-design.md`) の「フォルダ構成（新レイアウト）」セクションをベースに、確定した最終構造を反映。

**Step 4: `docs/archtecture/tech.md` の更新**

Edit: `docs/archtecture/tech.md`

以下の点を更新:
1. CLI呼び出し方式を `aikata-pr review [options]` サブコマンドに変更したことを明記
2. APIサーバが「featureモジュールのloop登録」により拡張される設計であることを明記
3. フォルダ構成への参照を更新

具体的には、「チェックロジック」セクションを以下のように補強:
```markdown
## チェックロジック（機能モジュール方式）
本プロジェクトは1つのCLI/1つのAPIサーバで複数のAI機能をホストする構造を採用。
各機能は `src/cli/<feature>/` と `src/presentation/api/<feature>/` に
`<feature>CliModule` / `<feature>ApiModule` を定義し、エントリ側がそれを配列で登録する。

現在提供中の機能:
- review: AIレビュー機能

新機能追加ガイド: `docs/archtecture/feature-extension.md`
```

CLIオプションリストの冒頭に「CLI呼び出しは `aikata-pr review [options]` のようにサブコマンドを必須とする」と追記。

**Step 5: 新機能追加ガイド `docs/archtecture/feature-extension.md` を作成**

Write: `docs/archtecture/feature-extension.md`

（内容: 以下のテンプレ）
```markdown
# 新機能追加ガイド

本プロジェクトにAIレビュー以外の新しいCI/CD機能（以下「機能」）を追加する手順。

## 全体像
1. 機能固有のドメイン・アプリケーション・Mastra・プレゼンテーション層コードを
   各レイヤーの `<feature>/` サブフォルダに配置する
2. CLIモジュール (`<feature>CliModule`) と APIモジュール (`<feature>ApiModule`) を定義する
3. `src/cli/dispatch.ts` の `defaultFeatures` 配列と `src/server.ts` の `apiFeatures` 配列に追加する
4. `.ci-template/pipelines/<feature>/` にパイプライン定義を置く
5. `.ci-template/variable/<feature>.yml` に機能固有の変数を置く
6. `docs/domain/<feature>/` に機能別ドキュメントを置く

## ステップ詳細

### 1. ソースコードの配置
新機能を `myfeature` と呼ぶ場合の配置:

- `src/domain/myfeature/` — エンティティ・値オブジェクト
- `src/application/myfeature/` — アプリケーションサービス
- `src/mastra/myfeature/{agents,tools,workflows}/` — Mastra定義
- `src/infrastructure/adapter/myfeature/` — 機能固有のアダプタ（必要なら）
- `src/presentation/api/myfeature/` — APIルート・ハンドラ
- `src/cli/myfeature/` — CLI実装

横断的に使えるロジックは `shared/` に置くこと。横断→機能依存は禁止。

### 2. CLIモジュールの定義
`src/cli/myfeature/index.ts` にて:
\`\`\`ts
export const myfeatureCliModule = {
  name: 'myfeature',
  description: 'Run myfeature on a GitLab MR',
  run: async (args: string[]) => { /* ... */ },
};
\`\`\`

### 3. APIモジュールの定義
`src/presentation/api/myfeature/index.ts` にて:
\`\`\`ts
export const myfeatureApiModule: ApiFeatureModule = {
  name: 'myfeature',
  register: (app, deps) => {
    const route = createMyfeatureRoute();
    app.route('/api/v1', route);
  },
};
\`\`\`

### 4. 機能モジュールの登録
- `src/cli/dispatch.ts` の `defaultFeatures` に `myfeatureCliModule` を追加
- `src/server.ts` の `apiFeatures` に `myfeatureApiModule` を追加

### 5. CIテンプレート
- `.ci-template/pipelines/myfeature/template.yml` と `template-npx.yml` を作成
- `.ci-template/variable/myfeature.yml` を作成
- 必要なら既存ユーザ向けに `.ci-template/pipelines/template.yml` のファサードをincludeで束ねる

### 6. テスト
- 既存テストの命名規則に従い `__tests__/` 配下に配置
- ディスパッチャと機能登録の動作確認には `src/cli/__tests__/dispatch.test.ts` と `src/presentation/api/__tests__/featureRegistration.test.ts` を参考にする

### 7. ドキュメント
- `docs/domain/myfeature/{entity.md, business_rule.md, usecase.md, glossary.md}` を作成
- 必要に応じて `docs/archtecture/myfeature/tech.md` を作成
- `AGENTS.md` および `docs/archtecture/tech.md` のCLIオプション一覧に追記

## 注意点
- クリーンアーキテクチャの依存方向（Presentation → Application → Domain）を守ること
- `shared` レイヤーは機能レイヤーに依存しないこと
- プロンプトは英語で書くこと（AGENTS.md方針）
```

**Step 6: `AGENTS.md` の更新**

Edit: `AGENTS.md`

以下を更新:
1. 「プレゼンテーション層」セクションのCLIインターフェース記述を `aikata-pr review [options]` に変更
2. 「作業時の注意点」に「新機能追加時は `docs/archtecture/feature-extension.md` を参照」を追加
3. 「コマンド」セクションの実行例を `node dist/index.js review ...` に変更

具体的な該当箇所は AGENTS.md を読んで特定する。

**Step 7: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス（docs変更はコードに影響しないため、変わらず）。

**Step 8: コミット**

Run:
```bash
git add -A
git commit -m "docs: プロジェクト再編に合わせてdocsを機能別構成へ更新"
```

---

## Task 14: PBI.md をdone化

**Step 1: PBI.md のID:1 ステータスを更新**

Edit: `PBI.md`

`- ステータス: to do` → `- ステータス: done`

もし `- 指摘事項（in progressの場合のみ）` の行が残っていれば、done時点では不要なので削除しても良い（雛形に合わせる）。

**Step 2: 検証**

Run:
```bash
npm run test && npm run lint && npm run build:cli
```
Expected: 全てパス。

**Step 3: コミット**

Run:
```bash
git add PBI.md
git commit -m "docs: pbi1 をdone化"
```

---

## Task 15: 最終スモーク & 受け入れ基準チェック

**Step 1: 全テスト・lint・buildの最終確認**

Run:
```bash
npm run test
npm run lint
npm run build:cli
```
Expected: 全てパス。

**Step 2: CLI手動スモーク**

Run:
```bash
node dist/index.js 2>&1 | head -20 || true
```
Expected: `Usage: aikata-pr` を含むメッセージ、exit code 1。

Run:
```bash
node dist/index.js unknown 2>&1 | head -20 || true
```
Expected: `Unknown command: unknown`、exit code 1。

Run:
```bash
node dist/index.js review 2>&1 | head -20 || true
```
Expected: 必須パラメータ不足のエラー（旧 `aikata-pr` をサブコマンドなしで実行した時と同じエラーメッセージ）。

**Step 3: APIサーバ起動スモーク（可能なら）**

Run:
```bash
npm run build:cli
# 最小環境変数での起動（.env.debug.server等がある前提）
# タイムアウト5秒で起動確認のみ
timeout 5 node dist/server.js 2>&1 || true
```
Expected: サーバ起動ログが出力される（`API server started` 等）。5秒でタイムアウトしても起動自体は確認できる。

**Step 4: 受け入れ基準の自己チェック**

設計書 (`docs/plans/2026-04-11-pbi1-project-restructure-design.md`) の「受け入れ基準」7項目を1つずつ確認:

1. ✅ 新レイアウトが `docs/archtecture/folder_structure.md` と一致
2. ✅ `aikata-pr review ...` でローカルモード・APIモード動作（手動実行までは不要、ただしコード構造上同一のロジックが呼ばれることを確認）
3. ✅ `node dist/server.js` が起動し `/api/v1/review` を持つ
4. ✅ test / lint / build pass
5. ✅ `feature-extension.md` が自己完結
6. ✅ `folder_structure.md`, `AGENTS.md`, `tech.md` が追随
7. ✅ `.ci-template/pipelines/template.yml` がファサードとして動作

**Step 5: 最終コミット不要（Task 14で完了）**

---

## 完了基準

- 上記15タスク全てが緑
- `git log --oneline` で変更履歴が論理的な単位で残っている
- 各コミットの diff が機械的移動＋importパス更新に限定されており、意味のあるロジック変更が混入していない
- 受け入れ基準7項目全てを満たす

## リスク時の回避策

### importパス置換漏れが頻発する場合
- 全ファイルを一度に直そうとせず、Task単位でコミットを小さく保つ
- Grepでパス文字列を事前に列挙してから置換する

### Mastraワークフローテストがランタイム失敗する場合
- `src/mastra/index.ts` のimport先更新が正しいかを再確認
- `mastra build` を実行して esbuild のバンドル時エラーを拾う

### git rename検出が効かずdiffが肥大化した場合
- 該当Taskをリセットし (`git reset --hard HEAD~1`)、ファイル内容変更を別コミットに分離して再実行
- `git log --follow <path>` で履歴追跡可能かを都度確認

### CLIサブコマンド変更で既存の `.env.debug.*` 経由の起動が動かない場合
- `.vscode/launch.json` の `args` に `"review"` を追加済みか確認（Task 10）
- 開発者の手元で `node_modules/.bin/aikata-pr` 経由で実行する場合も `review` サブコマンドを忘れないよう周知
