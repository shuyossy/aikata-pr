# PBI1: 将来の機能拡張に向けたプロジェクト再編 設計

- 作成日: 2026-04-11
- 対象PBI: PBI1「将来の機能拡張に向けたプロジェクト再編」
- ステータス: 設計承認済

## 背景と目的

AIを利用したCI/CDジョブの需要が高まる中、AIレビュー以外にも複数機能（AIテスト生成、AIドキュメント生成など）をテンプレートとして提供していく方針が決まっている。機能ごとに別プロジェクトを立てると、サーバ準備・管理負荷が増すため、本プロジェクトを**1パッケージで複数のAI CIジョブをホストできる構造**に再編する。

本PBIは**純粋な再編**であり、振る舞いは一切変えない。既存のAIレビュー機能は完全に同一の動作を維持する。

## 方針サマリ

| 軸 | 決定 |
|---|---|
| 機能の粒度 | ジョブ単位（1機能 = 1 CIジョブ） |
| CLIエントリ | 共通CLI `aikata-pr` にサブコマンド方式（`aikata-pr review ...`）。bin名は `aikata-pr` のまま維持 |
| APIサーバ | 共通サーバに機能ルートを登録（`/api/v1/review` など） |
| ソース構成 | レイヤーファースト（各層に `shared/` と `<feature>/` サブフォルダ） |
| featureモジュール | `{cli,api}Module` 記述子で機能を宣言し、エントリ側は配列loopで登録 |
| CIテンプレート | `.ci-template/pipelines/<feature>/` に実体を置き、既存パスはファサードで後方互換維持 |
| CI変数 | `shared.yml` + `<feature>.yml` に分割、既存 `variables.yml` はファサード |
| docs | `docs/domain/<feature>/` に機能別資料、横断用語は上位の `glossary.md` に残す |

## 全体アーキテクチャ

### 1パッケージ・1CLI・1サーバ・複数機能

- npm パッケージ: `@aikata/aikata-pr`（現状維持）
- bin名: `aikata-pr`（現状維持）
- CLI呼び出し: `aikata-pr <feature-name> [options]`
  - 例: `aikata-pr review --checklist ./checklist.csv ...`
  - 将来例: `aikata-pr test-gen --spec ./spec.md ...`
- APIサーバ: `node dist/server.js` で全機能のルートを1プロセスでホスト
  - `/api/v1/review`（既存）
  - 将来 `/api/v1/test-gen` 等

### featureモジュール登録パターン

各機能は2つの薄いモジュール記述子をexportする:

```ts
// CLI側: src/cli/review/index.ts
export const reviewCliModule = {
  name: 'review',
  description: 'Run AI review on a GitLab MR',
  run: async (args: string[], env: Record<string, string | undefined>) => {
    // 旧 src/index.ts の main() 本体
  },
};

// API側: src/presentation/api/review/index.ts
export const reviewApiModule = {
  name: 'review',
  register: (app: Hono, deps: ReviewHandlerDeps) => {
    app.route('/api/v1', createReviewRoute());
  },
};
```

エントリ側は機能モジュール配列をloopして登録する:

```ts
// src/cli.ts
const features = [reviewCliModule /*, 将来 testGenCliModule */];
const subcommand = args[0];
const feature = features.find((f) => f.name === subcommand);
if (!feature) {
  printUsage(features);
  process.exit(1);
}
await feature.run(args.slice(1), process.env);

// src/server.ts
const features = [reviewApiModule];
features.forEach((f) => f.register(app, deps));
```

**新機能追加時の変更箇所**: 機能フォルダを作成し、`features` 配列に1行追加するだけ。

Mastraについては `src/mastra/index.ts` が各feature下の `agents/tools/workflows` を集約してMastraインスタンスを組み立てる（現状のインポートパスだけが変わる）。

## フォルダ構成（新レイアウト）

```
.ci-template/
  pipelines/
    template.yml          # ファサード: review/template.yml をinclude（後方互換）
    template-npx.yml      # ファサード: review/template-npx.yml をinclude
    review/
      template.yml        # 実体（現template.ymlを移動）
      template-npx.yml
  variable/
    variables.yml         # ファサード: shared.yml + review.yml をinclude
    shared.yml            # 横断変数
    review.yml            # review固有変数
docs/
  domain/
    glossary.md           # 横断用語のみ
    review/
      glossary.md         # reviewドメイン用語（チェックリスト、評定等）
      entity.md
      business_rule.md
      usecase.md
  archtecture/
    tech.md               # 横断アーキテクチャ
    folder_structure.md   # 新レイアウト説明
    feature-extension.md  # 新機能追加ガイド（新規）
    review/
      tech.md             # review特有のフロー/シーケンス（必要分）
  config/
    env_val.md
  plans/
src/
  cli.ts                  # サブコマンドディスパッチャ
  server.ts               # featureモジュールをloop登録
  domain/
    shared/
    review/
      checkItem/
      checklist/
      mrContext/
      qualityGate/
      rating/
      reviewResult/
      reviewSettings/
  application/
    shared/               # parser/ comment/ prompt/ diffCompression/ port/
    review/
      reviewExecution/
      commentPosting/
  mastra/
    index.ts              # Mastra組み立て（各feature moduleのagents/tools/workflowsを集約）
    shared/
      requestContext.ts
    review/
      agents/
      tools/
      workflows/
      indexedCheckItem.ts
      types.ts
  infrastructure/
    adapter/
      httpClient/         # shared
      auth/               # shared
      clone/              # shared
      rateLimiter/        # shared
      tokenCounter/       # shared
      gateway/            # GitLabApiClient, MrGateway, LocalGitDiffMrGateway, LocalProjectTreeGateway（shared）
      review/
        gateway/          # GitLabMrDiscussionGateway
        apiClient/        # ReviewApiClient
        workflow/         # MastraReviewWorkflowRunner
  presentation/
    api/
      shared/             # createApp基盤, requestIdMiddleware
      review/             # reviewRoute, reviewHandler, reviewApiModule
  cli/
    shared/               # CLI横断ヘルパ（将来必要になれば）
    review/               # review固有: parseReviewArgs, commandBuilder, reviewCliModule
  lib/                    # 横断: logger, rateLimiterGlobal, cliCore, aiApiError, errorClassifier, rateLimitRetry, imageFormat
```

## ファイル移動マッピング

### ドメイン層

```
src/domain/checkItem/           → src/domain/review/checkItem/
src/domain/checklist/           → src/domain/review/checklist/
src/domain/mrContext/           → src/domain/review/mrContext/
src/domain/qualityGate/         → src/domain/review/qualityGate/
src/domain/rating/              → src/domain/review/rating/
src/domain/reviewResult/        → src/domain/review/reviewResult/
src/domain/reviewSettings/      → src/domain/review/reviewSettings/
```

`src/domain/shared/` は `.gitkeep` のみ（将来横断ドメイン用の予約）。

### アプリケーション層

```
src/application/reviewExecution/  → src/application/review/reviewExecution/
src/application/commentPosting/   → src/application/review/commentPosting/
src/application/shared/           → 変更なし
```

### Mastra層

```
src/mastra/agents/               → src/mastra/review/agents/
src/mastra/tools/                → src/mastra/review/tools/
src/mastra/workflows/            → src/mastra/review/workflows/
src/mastra/indexedCheckItem.ts   → src/mastra/review/indexedCheckItem.ts
src/mastra/types.ts              → src/mastra/review/types.ts
src/mastra/requestContext.ts     → src/mastra/shared/requestContext.ts
src/mastra/index.ts              → import先パスのみ更新
src/mastra/__tests__/            → importパスのみ更新
```

### インフラ層

```
adapter/httpClient/              → 変更なし（shared）
adapter/auth/                    → 変更なし（shared）
adapter/clone/                   → 変更なし（shared）
adapter/rateLimiter/             → 変更なし（shared）
adapter/tokenCounter/            → 変更なし（shared）
adapter/gateway/GitLabApiClient系       → 変更なし（shared）
adapter/gateway/GitLabMrGateway         → 変更なし（shared、他機能でも差分参照は再利用可能）
adapter/gateway/LocalGitDiffMrGateway   → 変更なし（shared）
adapter/gateway/LocalProjectTreeGateway → 変更なし（shared）
adapter/gateway/GitLabMrDiscussionGateway → adapter/review/gateway/GitLabMrDiscussionGateway
adapter/apiClient/               → adapter/review/apiClient/
adapter/workflow/                → adapter/review/workflow/
```

### プレゼンテーション層

```
src/presentation/api/requestIdMiddleware.ts  → src/presentation/api/shared/requestIdMiddleware.ts
src/presentation/api/reviewRoute.ts          → src/presentation/api/review/reviewRoute.ts
src/presentation/api/reviewHandler.ts        → src/presentation/api/review/reviewHandler.ts
src/presentation/api/__tests__/              → importパス更新
```

`src/presentation/api/review/index.ts` に `reviewApiModule` をexport。

### CLI層

```
src/index.ts                                 → 削除（main()本体はsrc/cli/review/index.ts へ）
src/lib/cli.ts                               → 汎用骨格は src/lib/cliCore.ts
                                                review固有は src/cli/review/parseReviewArgs.ts
src/lib/commandBuilder.ts                    → src/cli/review/commandBuilder.ts
(新規) src/cli.ts                            → サブコマンドディスパッチャ
(新規) src/cli/review/index.ts               → reviewCliModule + run()（旧main相当）
```

### lib層（横断で残るもの）

```
src/lib/logger.ts               変更なし
src/lib/rateLimiterGlobal.ts    変更なし
src/lib/aiApiError.ts           変更なし
src/lib/errorClassifier.ts      変更なし
src/lib/rateLimitRetry.ts       変更なし
src/lib/imageFormat.ts          変更なし
src/lib/__tests__/              importパス更新
```

### build.ts

```ts
entryPoints: ['src/cli.ts']    // 旧 src/index.ts
outfile: 'dist/index.js'       // 不変（bin参照を壊さない）
```

`dist/index.js` の出力名を変えないことで、`package.json` の `bin.aikata-pr`、Dockerfile、npx経路のいずれも影響を受けない。

## 後方互換の扱い

### バックエンド側

システム未リリースのため不要（AGENTS.md方針）:
- CLIは `review` サブコマンドを必須化する。サブコマンド無し・未知のサブコマンドはusage表示で非0終了
- 内部のimportパスも後方互換の再export層は設けない

### CIテンプレート側

既存の `.ci-template/pipelines/template.yml` をincludeしているユーザは**変更不要で引き続き動作**する:

**`.ci-template/pipelines/template.yml`（ファサード）**
```yaml
include:
  - local: '.ci-template/pipelines/review/template.yml'
```

**`.ci-template/pipelines/template-npx.yml`（ファサード）**
```yaml
include:
  - local: '.ci-template/pipelines/review/template-npx.yml'
```

**`.ci-template/pipelines/review/template.yml`（実体）**

現行 `template.yml` の内容を丸ごと移動。内部の `script:` 内の `aikata-pr` 呼び出しを `aikata-pr review` に変更（1行のみ）。他は同一。`template-npx.yml` も同様。

**`.ci-template/variable/variables.yml`（ファサード）**
```yaml
include:
  - local: '.ci-template/variable/shared.yml'
  - local: '.ci-template/variable/review.yml'
```

**`.ci-template/variable/shared.yml`（横断変数）**
```yaml
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
  # API Mode
  AIKATA_API_URL: ""
  # Container Image
  AIKATA_IMAGE: ""
  AIKATA_IMAGE_TAG: "latest"
  # npm
  AIKATA_PROJECT_ID: ""
  AIKATA_VERSION: "latest"
  # Context Length（AI全般）
  MAX_CONTEXT_LENGTH: ""
```

**`.ci-template/variable/review.yml`（review固有）**
```yaml
variables:
  GITLAB_MR_IID: "$CI_MERGE_REQUEST_IID"
  CHECKLIST_PATH: ""
  CHECKLIST_COLUMNS: ""
  CHECKLIST_NO_HEADER: "false"
  REVIEW_SETTINGS_PATH: ""
  SKILLS_PATH: ""
  COMMENT_LANGUAGE: "Japanese"
  TREE_MAX_DEPTH: ""
```

## テスト戦略

本PBIは純粋な再編なので、**既存テストを全てパスさせることが合否基準**。

### 既存テスト
- ユニット、Mastraワークフロー、プレゼンテーション、libの各テストは**importパス更新のみ**許容、アサーションや構造の変更は禁止

### 新規テスト（最小限）

1. `src/cli/__tests__/dispatch.test.ts`
   - `aikata-pr review ...` が `reviewCliModule.run` を呼ぶこと
   - 未知サブコマンドでusage表示し非0終了
   - サブコマンド無しでusage表示し非0終了

2. `src/presentation/api/__tests__/featureRegistration.test.ts`
   - `features` 配列をloopして `apiModule.register` が呼ばれること
   - `/api/v1/review` のルートが登録されていること

### 合格条件
- `npm run test` 全パス
- `npm run lint` 通過
- `npm run build:cli` 成功
- 必要に応じ `node dist/index.js review --help` で最小動作確認

## 実装順序

各ステップは単独でテスト/ビルドが通る形を維持する。

1. **スケルトン作成**: 空ディレクトリに `.gitkeep` 配置
2. **ドメイン層の移動**（git mv + importパス更新を同一コミット）
3. **アプリケーション層の移動**
4. **Mastra層の移動**
5. **インフラ層のreview固有部分の移動**
6. **プレゼンテーション層の移動**（requestIdMiddlewareはshared、review系はreview配下）
7. **CLI層の分割とサブコマンド化**
   - `src/lib/cli.ts` → `src/lib/cliCore.ts` + `src/cli/review/parseReviewArgs.ts`
   - `src/lib/commandBuilder.ts` → `src/cli/review/commandBuilder.ts`
   - 旧 `src/index.ts` の `main()` → `src/cli/review/index.ts` の `run(args, env)`
   - 新規 `src/cli.ts` にディスパッチャ
   - `build.ts` のentryPoint更新（outfileは不変）
   - 新規テスト `dispatch.test.ts` 追加
8. **featureモジュールパターンをAPIに適用**
   - `reviewApiModule` export
   - `src/server.ts` の `createApp` をloop登録に変更
   - 新規テスト `featureRegistration.test.ts` 追加
9. **CIテンプレート・変数の分割**
   - `.ci-template/pipelines/review/` 新設、既存ファイルはファサード化
   - `.ci-template/variable/shared.yml` と `review.yml` 新設、`variables.yml` はファサード
   - 本プロジェクトの `.gitlab-ci.yml` への影響確認
10. **docs再編**
    - `docs/domain/review/` に機能別資料を分離、`glossary.md` は横断用語のみ
    - `docs/archtecture/folder_structure.md` 全面更新
    - `docs/archtecture/tech.md` 更新
    - `docs/archtecture/feature-extension.md` 新規作成
    - `AGENTS.md` のCLIオプション・フォルダ構成セクション更新
11. **PBI.md更新**: ステータスを `done` に

## リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| git rename検出失敗でdiffが肥大化 | レビュー性低下 | 移動と内容変更を同一コミット内に抑える。移動後 `git log --follow` で追跡可能を確認 |
| Mastra AIワークフローのimportパスがzodスキーマ参照を壊す | ビルド通過してもランタイム失敗 | 各ステップ後に `npm run build` を実行、可能ならMastra初期化までスモーク |
| `dist/index.js` パス変更でDocker/npx経路が壊れる | 実利用への影響 | `dist/index.js` 出力名を不変に保つ。`build.ts` 内で `src/cli.ts` → `dist/index.js` 固定 |
| `.ci-template/variable/variables.yml` のネスト `include` が解決されない | ジョブ起動失敗 | GitLab CIはネスト `include` に対応しているため問題ない想定だが、本プロジェクトの `.gitlab-ci.yml` への影響を事前確認 |
| `shared` が `feature` を参照する逆依存 | コンパイル失敗・設計崩壊 | レイヤールール（shared は feature を知らない）を人間レビューで厳守 |
| `.env.debug.api` / `.env.debug.server` の起動スクリプトが動かなくなる | 開発者の手元で詰まる | `.vscode/launch.json` 等を確認し、サブコマンド追加に合わせて更新 |
| 中間コミットでビルドが通らない | `git bisect` 困難 | ステップ順を厳守、各ステップ完了時に `npm run test && npm run lint && npm run build:cli` を必ず実行 |

## 受け入れ基準

1. 新レイアウトがAGENTS.md / `docs/archtecture/folder_structure.md` の記述と一致している
2. `aikata-pr review ...` で従来と同一の動作（ローカルモード・APIモード両方）
3. `node dist/server.js` でAPIサーバが起動し、`POST /api/v1/review` が従来と同一の動作
4. `npm run test` 全パス、`npm run lint` 通過、`npm run build:cli` 成功
5. `docs/archtecture/feature-extension.md` を読めば「新しいAI機能を追加する手順」が自己完結で分かる
6. `docs/archtecture/folder_structure.md`, `AGENTS.md`, `docs/archtecture/tech.md` が新レイアウトに追随している
7. 既存CIテンプレート利用者（`.ci-template/pipelines/template.yml` や `template-npx.yml` をincludeしているプロジェクト）は変更不要で動作する

## 非スコープ

- 新機能の追加（本PBIは再編のみ）
- 既存AIレビュー機能のロジック変更
- 依存ライブラリのバージョンアップ
- テストの拡充（既存テストを動かす以上のもの）
- package名・bin名の変更
