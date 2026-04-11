# 新機能追加ガイド

本プロジェクトにAIレビュー以外の新しいCI/CD機能（以下「機能」）を追加するための手順。

## 全体像

1. 機能固有のドメイン・アプリケーション・Mastra・プレゼンテーション層コードを各レイヤーの `<feature>/` サブフォルダに配置する
2. CLIモジュール (`<feature>CliModule`) と APIモジュール (`<feature>ApiModule`) を定義する
3. `src/cli/dispatch.ts` の `defaultFeatures` 配列と `src/server.ts` の `apiFeatures` 配列に追加する
4. `.ci-template/pipelines/<feature>/` にパイプライン定義を置く
5. `.ci-template/variable/<feature>.yml` に機能固有の変数を置く
6. `docs/domain/<feature>/` に機能別ドキュメントを置く

## レイヤー構造のおさらい

```
src/
  cli/
    dispatch.ts             # サブコマンド分岐
    <feature>/              # ここに機能ごとのCLI実装
  domain/
    shared/                 # 全機能横断のドメイン（必要なとき）
    <feature>/              # 機能固有のエンティティ・値オブジェクト
  application/
    shared/                 # parser/comment/prompt/port等の横断
    <feature>/              # 機能固有のアプリケーションサービス
  presentation/
    api/
      shared/               # featureModule, requestIdMiddleware 等の横断
      <feature>/            # 機能固有のHonoルート・ハンドラ
  mastra/
    shared/                 # 横断用
    <feature>/              # 機能固有のagents/tools/workflows
  infrastructure/
    adapter/
      (横断的アダプタは直下のまま)
      <feature>/            # 機能固有のアダプタ
```

## ステップ詳細

### 1. ソースコードの配置

新機能を `myfeature` とする:

- `src/domain/myfeature/` — エンティティ・値オブジェクト
- `src/application/myfeature/` — アプリケーションサービス
- `src/mastra/myfeature/{agents,tools,workflows}/` — Mastra定義
- `src/infrastructure/adapter/myfeature/` — 機能固有アダプタ（必要に応じて）
- `src/presentation/api/myfeature/` — APIルート・ハンドラ
- `src/cli/myfeature/` — CLI実装

横断的に使えるロジックは `shared/` に置く。**`shared` から `<feature>` への依存は禁止。**

### 2. CLIモジュールの定義

`src/cli/myfeature/index.ts`:

```ts
import type { CliFeatureModule } from '../dispatch.js';

export async function run(args: string[]): Promise<void> {
  // 引数パース、各種初期化、ビジネスロジック呼び出し
}

export const myfeatureCliModule: CliFeatureModule = {
  name: 'myfeature',
  description: 'Run myfeature on a GitLab MR',
  run,
};
```

### 3. APIモジュールの定義

`src/presentation/api/myfeature/index.ts`:

```ts
import type { Hono } from 'hono';
import type { ApiFeatureModule } from '../shared/featureModule.js';
import { createMyfeatureRoute } from './myfeatureRoute.js';

// 機能ごとに固有のenv union（JwtAuthEnv等と組み合わせ）
type MyfeatureEnv = /* ... */;

export const myfeatureApiModule: ApiFeatureModule<MyfeatureEnv> = {
  name: 'myfeature',
  register: (app) => {
    const route = createMyfeatureRoute();
    app.route('/api/v1', route);
  },
};
```

depsはHonoコンテキスト経由でリクエストハンドラに流すため、register関数では受け取らない（depsの注入は `src/server.ts` の `createApp` 内のミドルウェアが担う）。

### 4. 機能モジュールの登録

- `src/cli/dispatch.ts` の `defaultFeatures` に `myfeatureCliModule` を追加
- `src/server.ts` の `apiFeatures` に `myfeatureApiModule` を追加

### 5. CIテンプレート

- `.ci-template/pipelines/myfeature/template.yml` と `template-npx.yml` を作成
- `.ci-template/variable/myfeature.yml` を作成（機能固有の変数）
- 全機能で共通する変数は `.ci-template/variable/shared.yml` に置く
- 既存ユーザ向けに `.ci-template/pipelines/template.yml` ファサードに `myfeature` をincludeするかどうかは要検討（機能ごとに独立したテンプレートファサードを作る方が無難）

### 6. ドキュメント

- `docs/domain/myfeature/{entity.md, business_rule.md, usecase.md, glossary.md}` を作成
- 横断的な用語が出たら `docs/domain/glossary.md` に追記
- 必要なら `docs/archtecture/myfeature/` を作って機能固有のアーキテクチャ図を置く
- `AGENTS.md` および `docs/archtecture/tech.md` のCLIコマンド一覧を更新

### 7. テスト

- 既存のテスト配置ルール（`__tests__/` 配下、SUTの近くに置く）に従う
- CLIサブコマンドのディスパッチは `src/cli/__tests__/dispatch.test.ts`、APIのfeature登録は `src/presentation/api/__tests__/featureRegistration.test.ts` を参考にする

## 注意点

- クリーンアーキテクチャの依存方向（Presentation → Application → Domain）を厳守
- `shared` レイヤーは `<feature>` レイヤーを参照しない
- 異なる機能同士は直接参照しない（連携が必要なら `shared` に抽出）
- プロンプトは英語で書く（AGENTS.md方針）
- 新規追加した部分についてTypeScript型エラーがないこと、すべてのテストがパスすること
