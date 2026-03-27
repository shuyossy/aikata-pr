# PBI ID:0 事前準備 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** ID:1以降の開発にスムーズに入れるよう、開発環境・CI/CD・共通基盤を整備する

**Architecture:** チェックロジックをCLIツールとして実装し、esbuild/tsupでバンドルして`dist/`に出力する。MastraのPinoLoggerを再利用してロガー基盤を構築する。GitLab CI/CDでテスト・lint・バンドル・リリースを自動化する。

**Tech Stack:** TypeScript, Vitest, ESLint, Prettier, Pino (via @mastra/loggers), esbuild/tsup, husky, lint-staged, commitlint, semantic-release, GitLab CI/CD

**設計ドキュメント:** `docs/plans/2026-03-27-pbi0-design.md`

---

### Task 1: Vitest のセットアップ

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `src/lib/__tests__/setup-check.test.ts`

**Step 1: vitest と関連パッケージをインストール**

Run: `npm install -D vitest @vitest/coverage-v8`

**Step 2: vitest 設定ファイルを作成**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/mastra/**',
      ],
      thresholds: {
        branches: 80,
      },
    },
  },
});
```

**Step 3: package.json の test スクリプトを更新**

`package.json` の `scripts.test` を `"vitest run"` に変更。
`scripts.test:watch` として `"vitest"` を追加。
`scripts.test:coverage` として `"vitest run --coverage"` を追加。

**Step 4: セットアップ確認テストを作成**

```typescript
// src/lib/__tests__/setup-check.test.ts
import { describe, it, expect } from 'vitest';

describe('vitest setup', () => {
  it('should run tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

**Step 5: テストを実行して動作確認**

Run: `npm run test`
Expected: PASS（1 test passed）

**Step 6: カバレッジ実行確認**

Run: `npm run test:coverage`
Expected: カバレッジレポートが出力される

**Step 7: セットアップ確認テストを削除**

`src/lib/__tests__/setup-check.test.ts` を削除（ロガーのテストで代替されるため）

**Step 8: コミット**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore: vitest のセットアップとカバレッジ設定を追加"
```

---

### Task 2: ESLint + Prettier のセットアップ

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `package.json`

**Step 1: ESLint と関連パッケージをインストール**

Run: `npm install -D eslint @eslint/js typescript-eslint`

**Step 2: Prettier 設定ファイルを作成**

```json
// .prettierrc.json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

```
# .prettierignore
node_modules
dist
.mastra
*.db
```

**Step 3: ESLint flat config を作成**

```javascript
// eslint.config.js
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', '.mastra/'],
  },
);
```

**Step 4: package.json の scripts を更新**

- `format` を `"prettier --write \"src/**/*.{ts,tsx}\""` に変更
- `format:check` として `"prettier --check \"src/**/*.{ts,tsx}\""` を追加
- `lint` として `"eslint src/"` を追加
- `lint:fix` として `"eslint src/ --fix"` を追加

**Step 5: lint と format を実行して動作確認**

Run: `npm run lint`
Expected: エラーなし（またはフォーマットのみのワーニング）

Run: `npm run format:check`
Expected: フォーマット状態が表示される

**Step 6: コミット**

```bash
git add eslint.config.js .prettierrc.json .prettierignore package.json package-lock.json
git commit -m "chore: ESLint と Prettier のセットアップ"
```

---

### Task 3: husky + lint-staged + commitlint のセットアップ

**Files:**
- Create: `.husky/pre-commit`
- Create: `.husky/commit-msg`
- Create: `.lintstagedrc.json`
- Create: `.commitlintrc.json`
- Modify: `package.json`

**Step 1: husky, lint-staged, commitlint をインストール**

Run: `npm install -D husky lint-staged @commitlint/cli @commitlint/config-conventional`

**Step 2: husky を初期化**

Run: `npx husky init`

**Step 3: lint-staged 設定ファイルを作成**

```json
// .lintstagedrc.json
{
  "src/**/*.{ts,tsx}": [
    "prettier --write",
    "eslint --fix"
  ]
}
```

**Step 4: commitlint 設定ファイルを作成**

```json
// .commitlintrc.json
{
  "extends": [
    "@commitlint/config-conventional"
  ]
}
```

**Step 5: husky フックを設定**

`.husky/pre-commit` の内容を `npx lint-staged` に変更する。

`.husky/commit-msg` を作成し、以下の内容を記載:

```bash
npx --no -- commitlint --edit $1
```

**Step 6: 動作確認**

適当なファイルに変更を加えてコミットし、lint-staged と commitlint が実行されることを確認。
不正なコミットメッセージ（例: `bad message`）でコミットが拒否されることも確認。

**Step 7: コミット**

```bash
git add .husky/ .lintstagedrc.json .commitlintrc.json package.json package-lock.json
git commit -m "chore: husky + lint-staged + commitlint の設定"
```

---

### Task 4: ロガーの調査と実装

**Files:**
- Create: `docs/archtecture/logger-investigation.md`
- Create: `src/lib/logger.ts`
- Create: `src/lib/__tests__/logger.test.ts`

**Step 1: MastraのPinoLogger再利用可否を調査しドキュメント作成**

調査ポイント:
- `node_modules/@mastra/loggers/dist/pino.d.ts` の `PinoLogger` クラス
- `child()` メソッドで userId バインディングが可能か
- `pino-std-serializers` の `errWithCause` が利用可能か
- カスタム serializer を formatters 経由で設定可能か

調査結論をドキュメントに記載:

```markdown
<!-- docs/archtecture/logger-investigation.md -->
# MastraのPinoLogger再利用調査

## 調査結果
（調査結果をここに記載）

## 結論
（再利用するか独自実装するかの判断と理由）
```

**Step 2: ロガーのテストを作成（失敗するテスト）**

```typescript
// src/lib/__tests__/logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLogger, initializeLogger } from '../logger';

describe('logger', () => {
  describe('initializeLogger', () => {
    it('should create a logger with userId binding', () => {
      initializeLogger({ userId: 'test-user' });
      const logger = getLogger();
      // ロガーが取得できることを確認
      expect(logger).toBeDefined();
      expect(logger.info).toBeTypeOf('function');
      expect(logger.error).toBeTypeOf('function');
      expect(logger.warn).toBeTypeOf('function');
      expect(logger.debug).toBeTypeOf('function');
    });
  });

  describe('getLogger', () => {
    it('should throw if called before initializeLogger', () => {
      // モジュールをリセットする必要あり
      expect(() => getLogger()).toThrow();
    });

    it('should return the same logger instance', () => {
      initializeLogger({ userId: 'test-user' });
      const logger1 = getLogger();
      const logger2 = getLogger();
      expect(logger1).toBe(logger2);
    });
  });

  describe('log output', () => {
    it('should include userId in log output', () => {
      // ログ出力にuserIdが含まれることを確認
      // 実装方法に応じてテスト内容を調整
    });

    it('should include timestamp in log output', () => {
      // ログ出力にタイムスタンプが含まれることを確認
    });
  });

  describe('error serialization', () => {
    it('should serialize errors with cause chain using errWithCause', () => {
      // エラーオブジェクトのcauseチェーンが正しくシリアライズされることを確認
    });
  });
});
```

**Step 3: テストが失敗することを確認**

Run: `npm run test`
Expected: FAIL（logger モジュールが存在しない）

**Step 4: ロガーモジュールを実装**

```typescript
// src/lib/logger.ts
import { PinoLogger } from '@mastra/loggers';
// pino-std-serializers は pino の依存として利用可能
import { errWithCause } from 'pino-std-serializers';

// ロガーの設定型
interface LoggerConfig {
  userId: string;
  level?: string;
}

// シングルトンロガーインスタンス
let loggerInstance: PinoLogger | null = null;

/**
 * ロガーを初期化する
 * アプリケーション起動時に一度だけ呼び出す
 */
export function initializeLogger(config: LoggerConfig): void {
  const baseLogger = new PinoLogger({
    name: 'aikata-pr',
    level: (config.level as any) ?? 'info',
    formatters: {
      log(object: Record<string, unknown>) {
        // errWithCause でエラーをシリアライズ
        if (object['err'] && object['err'] instanceof Error) {
          return { ...object, err: errWithCause(object['err'] as Error) };
        }
        return object;
      },
    },
  });

  // child ロガーでユーザIDをバインド
  loggerInstance = baseLogger.child({ userId: config.userId });
}

/**
 * ロガーを取得する
 * initializeLogger が呼ばれていない場合はエラー
 */
export function getLogger(): PinoLogger {
  if (!loggerInstance) {
    throw new Error('Logger is not initialized. Call initializeLogger() first.');
  }
  return loggerInstance;
}
```

注意: 上記は調査結果に基づく暫定実装。調査の結果、MastraのPinoLoggerが要件を満たせない場合は、pinoを直接利用する実装に切り替える。その場合は `pino` と `pino-std-serializers` を直接 dependencies に追加する。

**Step 5: テストが通ることを確認**

Run: `npm run test`
Expected: PASS

**Step 6: テストを拡充し、分岐カバレッジ80%以上を確認**

Run: `npm run test:coverage`
Expected: `src/lib/logger.ts` の branch coverage が 80% 以上

**Step 7: コミット**

```bash
git add docs/archtecture/logger-investigation.md src/lib/logger.ts src/lib/__tests__/logger.test.ts
git commit -m "feat: ロガー基盤の実装（PinoLogger + userId/時刻バインディング）"
```

---

### Task 5: 環境変数ドキュメントの整備

**Files:**
- Modify: `.env.example`
- Create: `.ci-template/variable/variables.yml`
- Modify: `docs/config/env_val.md`

**Step 1: `docs/config/env_val.md` を更新**

```markdown
# 環境変数設計

本アプリは環境変数で様々な挙動の制御が可能

| カテゴリ | 変数名 | 必須 | 既定値 | 主な制御内容 | CLIオプション | 参照箇所 |
| --- | --- | --- | --- | --- | --- | --- |
| AI | AI_API_KEY | Yes | - | AI APIキー（秘密情報） | なし（環境変数のみ） | - |
| AI | AI_API_ENDPOINT_URL | Yes | - | AI APIエンドポイントURL | なし（環境変数のみ） | - |
| GitLab | GITLAB_API_TOKEN | Yes | - | GitLab APIトークン（秘密情報） | なし（環境変数のみ） | - |
| GitLab | GITLAB_PROJECT_ID | Yes | - | GitLabプロジェクトID | --project-id | - |
| GitLab | GITLAB_MR_IID | Yes | - | マージリクエストIID | --mr-iid | - |
| 入力 | CHECKLIST_PATH | Yes | - | チェックリストファイルパス | --checklist | - |
| 入力 | REVIEW_SETTINGS_PATH | No | - | レビュー設定ファイルパス | --review-settings | - |
| 入力 | SKILLS_PATH | No | - | skillsパス | --skills | - |
| 動作設定 | USER_ID | Yes | - | 実行ユーザID | --user-id | - |
| 動作設定 | LOG_LEVEL | No | info | ログレベル | --log-level | - |
| 動作設定 | VERBOSE_ERROR | No | false | エラーログ詳細表示の有無 | --verbose-error | - |
```

**Step 2: `.env.example` を更新**

```
# AI
AI_API_KEY=your-api-key
AI_API_ENDPOINT_URL=https://api.example.com/v1

# GitLab
GITLAB_API_TOKEN=your-gitlab-token
GITLAB_PROJECT_ID=
GITLAB_MR_IID=

# Input
CHECKLIST_PATH=
REVIEW_SETTINGS_PATH=
SKILLS_PATH=

# Settings
USER_ID=
LOG_LEVEL=info
VERBOSE_ERROR=false
```

**Step 3: `.ci-template/variable/variables.yml` を作成**

```yaml
# 提供用CIテンプレートのデフォルト変数
variables:
  # AI
  AI_API_KEY: ""
  AI_API_ENDPOINT_URL: ""
  # GitLab
  GITLAB_API_TOKEN: ""
  GITLAB_PROJECT_ID: "$CI_PROJECT_ID"
  GITLAB_MR_IID: "$CI_MERGE_REQUEST_IID"
  # Input
  CHECKLIST_PATH: ""
  REVIEW_SETTINGS_PATH: ""
  SKILLS_PATH: ""
  # Settings
  USER_ID: "$GITLAB_USER_LOGIN"
  LOG_LEVEL: "info"
  VERBOSE_ERROR: "false"
```

**Step 4: コミット**

```bash
git add .env.example docs/config/env_val.md .ci-template/variable/variables.yml
git commit -m "docs: 環境変数設計の整備"
```

---

### Task 6: .ci-template の整備

**Files:**
- Create: `.ci-template/pipelines/template.yml`

**Step 1: 提供用CIテンプレートを作成**

```yaml
# .ci-template/pipelines/template.yml
# 提供先プロジェクトで include して利用するCIテンプレート
#
# 使い方:
#   include:
#     - project: '<本プロジェクトのパス>'
#       file: '.ci-template/pipelines/template.yml'

include:
  - local: '.ci-template/variable/variables.yml'

stages:
  - review

ai-review:
  stage: review
  image: node:22
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script:
    # チェックロジックをGeneric PackagesからDL
    - |
      PACKAGE_URL="${CI_API_V4_URL}/projects/${AIKATA_PROJECT_ID}/packages/generic/aikata-pr/${AIKATA_VERSION}/index.js"
      curl --header "PRIVATE-TOKEN: ${AIKATA_DOWNLOAD_TOKEN}" -o index.js "${PACKAGE_URL}"
    # チェックロジック実行
    - node index.js
      --user-id "${USER_ID}"
      --project-id "${GITLAB_PROJECT_ID}"
      --mr-iid "${GITLAB_MR_IID}"
      --checklist "${CHECKLIST_PATH}"
      --review-settings "${REVIEW_SETTINGS_PATH}"
      --skills "${SKILLS_PATH}"
      --log-level "${LOG_LEVEL}"
      --verbose-error "${VERBOSE_ERROR}"
```

注意: テンプレートの詳細はPBI ID:1以降で調整する可能性がある。現時点では骨組みを用意する。

**Step 2: コミット**

```bash
git add .ci-template/pipelines/template.yml
git commit -m "chore: 提供用CIテンプレートの雛形を作成"
```

---

### Task 7: CLI エントリーポイントの実装

**Files:**
- Create: `src/index.ts`
- Create: `src/lib/cli.ts`
- Create: `src/lib/__tests__/cli.test.ts`

**Step 1: CLI オプションパーサーのテストを作成（失敗するテスト）**

```typescript
// src/lib/__tests__/cli.test.ts
import { describe, it, expect } from 'vitest';
import { parseCliOptions, CliOptions } from '../cli';

describe('parseCliOptions', () => {
  it('should parse --user-id option', () => {
    const result = parseCliOptions(['--user-id', 'test-user']);
    expect(result.userId).toBe('test-user');
  });

  it('should fallback to USER_ID env var when --user-id not provided', () => {
    const result = parseCliOptions([], { USER_ID: 'env-user' });
    expect(result.userId).toBe('env-user');
  });

  it('should prefer CLI option over env var', () => {
    const result = parseCliOptions(['--user-id', 'cli-user'], { USER_ID: 'env-user' });
    expect(result.userId).toBe('cli-user');
  });

  it('should parse all supported options', () => {
    const result = parseCliOptions([
      '--user-id', 'u1',
      '--project-id', 'p1',
      '--mr-iid', '42',
      '--checklist', '/path/to/checklist.csv',
      '--review-settings', '/path/to/settings.json',
      '--skills', '/path/to/skills',
      '--log-level', 'debug',
      '--verbose-error',
    ]);
    expect(result.userId).toBe('u1');
    expect(result.projectId).toBe('p1');
    expect(result.mrIid).toBe('42');
    expect(result.checklist).toBe('/path/to/checklist.csv');
    expect(result.reviewSettings).toBe('/path/to/settings.json');
    expect(result.skills).toBe('/path/to/skills');
    expect(result.logLevel).toBe('debug');
    expect(result.verboseError).toBe(true);
  });

  it('should use default values when not specified', () => {
    const result = parseCliOptions([], {});
    expect(result.logLevel).toBe('info');
    expect(result.verboseError).toBe(false);
  });
});
```

**Step 2: テストが失敗することを確認**

Run: `npm run test`
Expected: FAIL（cli モジュールが存在しない）

**Step 3: CLI オプションパーサーを実装**

```typescript
// src/lib/cli.ts
export interface CliOptions {
  userId?: string;
  projectId?: string;
  mrIid?: string;
  checklist?: string;
  reviewSettings?: string;
  skills?: string;
  logLevel: string;
  verboseError: boolean;
}

/**
 * CLIオプションをパースする
 * 優先順位: CLIオプション > 環境変数 > デフォルト値
 */
export function parseCliOptions(
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): CliOptions {
  const parsed: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--user-id':
        parsed['userId'] = args[++i];
        break;
      case '--project-id':
        parsed['projectId'] = args[++i];
        break;
      case '--mr-iid':
        parsed['mrIid'] = args[++i];
        break;
      case '--checklist':
        parsed['checklist'] = args[++i];
        break;
      case '--review-settings':
        parsed['reviewSettings'] = args[++i];
        break;
      case '--skills':
        parsed['skills'] = args[++i];
        break;
      case '--log-level':
        parsed['logLevel'] = args[++i];
        break;
      case '--verbose-error':
        parsed['verboseError'] = true;
        break;
    }
  }

  return {
    userId: (parsed['userId'] as string) ?? env['USER_ID'],
    projectId: (parsed['projectId'] as string) ?? env['GITLAB_PROJECT_ID'],
    mrIid: (parsed['mrIid'] as string) ?? env['GITLAB_MR_IID'],
    checklist: (parsed['checklist'] as string) ?? env['CHECKLIST_PATH'],
    reviewSettings: (parsed['reviewSettings'] as string) ?? env['REVIEW_SETTINGS_PATH'],
    skills: (parsed['skills'] as string) ?? env['SKILLS_PATH'],
    logLevel: (parsed['logLevel'] as string) ?? env['LOG_LEVEL'] ?? 'info',
    verboseError: (parsed['verboseError'] as boolean) ?? env['VERBOSE_ERROR'] === 'true' ?? false,
  };
}
```

**Step 4: テストが通ることを確認**

Run: `npm run test`
Expected: PASS

**Step 5: エントリーポイントを作成**

```typescript
// src/index.ts
import { parseCliOptions } from './lib/cli';
import { initializeLogger, getLogger } from './lib/logger';

function main(): void {
  const options = parseCliOptions(process.argv.slice(2), process.env as Record<string, string>);

  // ロガー初期化
  initializeLogger({
    userId: options.userId ?? 'unknown',
    level: options.logLevel,
  });

  const logger = getLogger();
  logger.info('aikata-pr started');
  logger.info('options', { options });
}

main();
```

**Step 6: テストのカバレッジを確認**

Run: `npm run test:coverage`
Expected: `src/lib/cli.ts` の branch coverage が 80% 以上

**Step 7: コミット**

```bash
git add src/index.ts src/lib/cli.ts src/lib/__tests__/cli.test.ts
git commit -m "feat: CLIエントリーポイントとオプションパーサーの実装"
```

---

### Task 8: バンドル設定

**Files:**
- Modify: `package.json`
- Create: `build.ts` (または `esbuild.config.ts`)

**Step 1: esbuild をインストール**

Run: `npm install -D esbuild`

**Step 2: バンドルスクリプトを作成**

```typescript
// build.ts
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [],
  minify: false,
  sourcemap: true,
});

console.log('Build complete: dist/index.js');
```

**Step 3: package.json にバンドルスクリプトを追加**

- `build:cli` として `"node --import tsx build.ts"` を追加（tsx が必要な場合は `npx tsx build.ts`）
- 注意: 既存の `build` スクリプト（`mastra build`）は残す

`tsx` をインストール:
Run: `npm install -D tsx`

**Step 4: バンドルを実行して動作確認**

Run: `npm run build:cli`
Expected: `dist/index.js` が生成される

**Step 5: バンドルされたCLIを実行して動作確認**

Run: `node dist/index.js --user-id test-user --log-level info`
Expected: ロガーが起動し、ユーザID付きのログが出力される

**Step 6: コミット**

```bash
git add build.ts package.json package-lock.json
git commit -m "chore: esbuild によるCLIバンドル設定"
```

---

### Task 9: .gitlab-ci.yml の整備

**Files:**
- Create: `.gitlab-ci.yml`

**Step 1: GitLab CI/CD パイプライン定義を作成**

```yaml
# .gitlab-ci.yml
# 本プロジェクトで利用するCI/CDパイプライン

stages:
  - test
  - build
  - release

# 共通設定
default:
  image: node:22

# キャッシュ設定
.node_cache:
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/

# テストジョブ
test:
  stage: test
  extends: .node_cache
  script:
    - npm ci
    - npm run test:coverage
  coverage: '/All files[^|]*\|[^|]*\s+([\d\.]+)/'

# Lint/Format チェックジョブ
lint:
  stage: test
  extends: .node_cache
  script:
    - npm ci
    - npm run lint
    - npm run format:check

# ビルドジョブ
build:
  stage: build
  extends: .node_cache
  script:
    - npm ci
    - npm run build:cli
  artifacts:
    paths:
      - dist/
    expire_in: 1 week
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

# リリースジョブ（semantic-release）
release:
  stage: release
  extends: .node_cache
  script:
    - npm ci
    - npm run build:cli
    - npx semantic-release
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
```

**Step 2: コミット**

```bash
git add .gitlab-ci.yml
git commit -m "ci: GitLab CI/CDパイプラインの定義"
```

---

### Task 10: semantic-release のセットアップ

**Files:**
- Modify: `package.json`
- Create: `.releaserc.json`

参照: `semactic-release-sample/` の設定をベースとする（コピー後、サンプルフォルダは削除）

**Step 1: semantic-release と関連プラグインをインストール**

Run: `npm install -D semantic-release@^24.2.3 @semantic-release/changelog@^6.0.3 @semantic-release/exec@^7.0.3 @semantic-release/git@^10.0.1 @semantic-release/gitlab-config@^14.0.1 conventional-changelog-conventionalcommits@^6 semantic-release-replace-plugin@^1.2.7`

**Step 2: `.releaserc.json` を作成（サンプルベース）**

`semactic-release-sample/.releaserc.json` をルートにコピーし、以下を変更:
- `@semantic-release/exec` の `prepareCmd` にビルドコマンドを追加
- `publishCmd` に Generic Packages への公開コマンドを追加
- `@semantic-release/gitlab` の `assets` をプロジェクトに合わせて調整
- `@semantic-release/git` の `assets` に `package.json` を追加

```json
{
  "extends": "@semantic-release/gitlab-config",
  "branches": [
    { "name": "main" },
    { "name": "+([0-9])?(.{+([0-9]),x}).x" },
    { "name": "dev-*", "channel": "dev", "prerelease": true },
    { "name": "next-*", "channel": "next", "prerelease": true },
    { "name": "pre-*", "channel": "pre", "prerelease": true },
    { "name": "rc-*", "channel": "rc", "prerelease": true },
    { "name": "alpha-*", "channel": "alpha", "prerelease": true },
    { "name": "beta-*", "channel": "beta", "prerelease": true }
  ],
  "plugins": [
    [
      "@semantic-release/commit-analyzer",
      {
        "preset": "conventionalcommits",
        "releaseRules": [
          {"type": "build", "release": "patch"},
          {"type": "chore", "release": false},
          {"type": "ci", "release": "patch"},
          {"type": "docs", "release": "patch"},
          {"type": "style", "release": "patch"},
          {"type": "refactor", "release": "patch"},
          {"type": "perf", "release": "patch"},
          {"type": "revert", "release": "patch"},
          {"type": "test", "release": "patch"}
        ]
      }
    ],
    [
      "semantic-release-replace-plugin",
      {
        "replacements": [
          {
            "files": ["README.md"],
            "from": "((?:[a-zA-Z0-9-]+\\/)?[a-zA-Z0-9-]+\\/[a-zA-Z0-9-]+:)[0-9]+\\.[0-9]+\\.[0-9]+",
            "to": "$1${nextRelease.version}"
          }
        ]
      }
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        "preset": "conventionalcommits",
        "presetConfig": {
          "types": [
            {"type": "feat", "section": "Features"},
            {"type": "fix", "section": "Bug Fixes"},
            {"type": "build", "section": "Build", "hidden": false},
            {"type": "chore", "section": "Chores", "hidden": true},
            {"type": "ci", "section": "CI", "hidden": false},
            {"type": "docs", "section": "Docs", "hidden": false},
            {"type": "style", "section": "Style", "hidden": false},
            {"type": "refactor", "section": "Refactor", "hidden": false},
            {"type": "perf", "section": "Performance", "hidden": false},
            {"type": "revert", "section": "Reverts", "hidden": false},
            {"type": "test", "section": "Tests", "hidden": false}
          ]
        }
      }
    ],
    [
      "@semantic-release/changelog",
      {
        "changelogFile": "CHANGELOG.md"
      }
    ],
    [
      "@semantic-release/git",
      {
        "assets": [
          "CHANGELOG.md",
          "README.md",
          "package.json"
        ]
      }
    ],
    [
      "@semantic-release/exec",
      {
        "prepareCmd": "npm run build:cli && printf 'RELEASE_VERSION=${nextRelease.version}\nCHANNEL=${nextRelease.channel}\nLAST_RELEASE_VERSION=${lastRelease.version}\nLAST_CHANNEL=${lastRelease.channel}\n' > release.env",
        "publishCmd": "curl --header \"JOB-TOKEN: ${CI_JOB_TOKEN}\" --upload-file dist/index.js \"${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/generic/aikata-pr/${nextRelease.version}/index.js\" && echo \"NEED_DEPLOY=1\" >> release.env"
      }
    ],
    [
      "@semantic-release/gitlab",
      {}
    ]
  ]
}
```

注意: `issueUrlFormat` はサンプルにある社内Redmine URLを除去した（本プロジェクトの課題管理に合わせて後から設定）。

**Step 3: `semactic-release-sample/` フォルダを削除**

Run: `rm -rf semactic-release-sample`

**Step 4: 動作確認（ドライラン）**

Run: `npx semantic-release --dry-run --no-ci`
Expected: エラーなく解析が完了すること（実際のリリースは行われない）
注意: GitLab環境でない場合はエラーになる可能性があるが、設定ファイルが正しく読み込まれることを確認する。

**Step 5: コミット**

```bash
git add .releaserc.json package.json package-lock.json
git commit -m "chore: semantic-release によるバージョン管理の導入"
```

---

### Task 11: AGENTS.md にコマンドを追記

**Files:**
- Modify: `AGENTS.md`

**Step 1: コマンドセクションを更新**

`AGENTS.md` の `# コマンド` セクション内の ```bash ブロックに以下を追記:

```bash
# テスト
npm run test              # テスト実行
npm run test:watch        # テスト（watchモード）
npm run test:coverage     # テスト + カバレッジ

# Lint / Format
npm run lint              # ESLint 実行
npm run lint:fix          # ESLint 自動修正
npm run format            # Prettier フォーマット
npm run format:check      # Prettier フォーマットチェック

# ビルド
npm run build:cli         # CLI用バンドル（dist/index.js）

# 実行
node dist/index.js --user-id <userId> [options]
```

**Step 2: コミット**

```bash
git add AGENTS.md
git commit -m "docs: 主要コマンドを AGENTS.md に追記"
```

---

### Task 12: 最終確認

**Step 1: 全テストが通ることを確認**

Run: `npm run test:coverage`
Expected: 全テスト PASS、分岐カバレッジ 80% 以上

**Step 2: lint/format チェック**

Run: `npm run lint && npm run format:check`
Expected: エラーなし

**Step 3: バンドルとCLI実行の確認**

Run: `npm run build:cli && node dist/index.js --user-id final-check`
Expected: ログ出力にユーザID `final-check` が含まれる

**Step 4: 受け入れ基準の確認**

`docs/plans/2026-03-27-pbi0-design.md` の受け入れ基準を全項目チェックし、全て満たしていることを確認する。
