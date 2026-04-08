# PBI #1: MRチェックコアロジックAPI化 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MRチェックのAI処理部分を外部HTTP APIとして切り出し、CLIはAPIクライアントとしてAPIを呼び出す形に改修する

**Architecture:** プレゼンテーション層の差し替え + Application層のサービス分割。Hono APIサーバーがAIレビュー実行を担当し、CLIはAPIクライアント + コメント投稿 + 品質ゲート評価を担当する。SSEでレスポンスをストリーミングし、JWTでGitLab CI/CDジョブを認証する。

**Tech Stack:** Hono, jose (JWT), Node.js 22, TypeScript, Vitest, esbuild, Docker

**設計書:** `docs/plans/2026-04-08-pbi1-api-externalization-design.md`

---

## 前提知識

### 現在のファイル構成（変更対象）

- `src/index.ts` — CLIエントリーポイント（改修）
- `src/application/executeReview/ExecuteReviewService.ts` — メインサービス（分割）
- `src/application/executeReview/ExecuteReviewCommand.ts` — 入力DTO（分割）
- `src/application/executeReview/ExecuteReviewDto.ts` — 出力DTO（分割）
- `src/lib/cli.ts` — CLIオプションパーサー（改修）
- `src/lib/rateLimitRetry.ts` — レート制限リトライ（既存）
- `src/lib/rateLimitCoordinator.ts` — グローバルコーディネーター（拡張）
- `build.ts` — esbuildビルド設定（server.ts追加）
- `.ci-template/variable/variables.yml` — CI変数デフォルト値（改修）
- `.env.example` — 環境変数例（改修）

### 新規作成ファイル

- `src/server.ts` — APIサーバーエントリーポイント
- `src/application/reviewExecution/ReviewExecutionService.ts` — AIレビュー実行サービス
- `src/application/reviewExecution/ReviewExecutionCommand.ts` — 入力DTO
- `src/application/reviewExecution/ReviewExecutionDto.ts` — 出力DTO
- `src/application/commentPosting/CommentPostingService.ts` — コメント投稿サービス
- `src/application/commentPosting/CommentPostingCommand.ts` — 入力DTO
- `src/infrastructure/adapter/auth/JwtAuthMiddleware.ts` — JWT認証ミドルウェア
- `src/infrastructure/adapter/clone/CloneManager.ts` — リポジトリクローン管理
- `src/infrastructure/adapter/clone/CloneManagerPort.ts` — ポートIF
- `src/infrastructure/adapter/rateLimiter/RateLimiter.ts` — レート制御（ラウンドロビン + TokenBucket）
- `src/infrastructure/adapter/rateLimiter/RateLimiterPort.ts` — ポートIF
- `src/infrastructure/adapter/apiClient/ReviewApiClient.ts` — CLI→API呼び出しクライアント
- `docker/prod/Dockerfile` — APIサーバー用Dockerfile
- `docker/prod/docker-compose.yml` — APIサーバー起動用

---

## Task 1: 依存ライブラリの追加

**Files:**
- Modify: `package.json`

**Step 1: honoとjoseをインストール**

```bash
npm install hono jose
```

**Step 2: インストール確認**

```bash
node -e "import('hono').then(() => console.log('hono OK'))"
node -e "import('jose').then(() => console.log('jose OK'))"
```

Expected: 両方OK

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add hono and jose dependencies for API externalization"
```

---

## Task 2: Application層分割 — ReviewExecutionService（AIレビュー専用）

現在の`ExecuteReviewService`からAIレビュー実行の責務を切り出す。コメント投稿・品質ゲート評価は含めない。

**Files:**
- Create: `src/application/reviewExecution/ReviewExecutionCommand.ts`
- Create: `src/application/reviewExecution/ReviewExecutionDto.ts`
- Create: `src/application/reviewExecution/ReviewExecutionService.ts`
- Create: `src/application/reviewExecution/index.ts`
- Test: `src/application/reviewExecution/__tests__/ReviewExecutionService.test.ts`

**Step 1: ReviewExecutionCommandを作成**

```typescript
// src/application/reviewExecution/ReviewExecutionCommand.ts
import { Checklist } from '../../domain/checklist/index.js';
import { ReviewSettings } from '../../domain/reviewSettings/index.js';

/**
 * ReviewExecutionServiceの入力DTO
 * AIレビュー実行に必要なパラメータのみを含む
 */
export interface ReviewExecutionCommand {
  userId: string;
  projectId: string;
  mrIid: string;
  checklist: Checklist;
  reviewSettings: ReviewSettings;
  skillsPaths: string[];
  projectDir: string;
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  gitlabToken: string;
  treeMaxDepth: number | undefined;
  commentLanguage: string;
  openaiReasoningEffort: string | undefined;
  maxContextLength: number | undefined;
}
```

**Step 2: ReviewExecutionDtoを作成**

```typescript
// src/application/reviewExecution/ReviewExecutionDto.ts
import { ReviewResult } from '../../domain/reviewResult/index.js';

/**
 * ReviewExecutionServiceの出力DTO
 * AIレビューの結果のみを含む（コメント投稿・品質ゲート評価は含まない）
 */
export interface ReviewExecutionDto {
  results: ReviewResult[];
  commitHash: string;
}
```

**Step 3: ReviewExecutionServiceを作成**

`ExecuteReviewService`から以下のメソッドを移植:
- `execute()` → AIレビュー実行のみ（コメント投稿・品質ゲート除外）
- `executeFullReview()` → コメント投稿・品質ゲート除外版
- `executeRetryReview()` → コメント投稿・品質ゲート除外版
- `buildPriorContext()` — そのまま
- `buildCommonWorkflowParams()` — そのまま
- `compressDiff()` — そのまま
- `buildEstimatedUserPrompt()` — そのまま
- `convertToReviewResults()` — そのまま
- `cleanupTempFiles()` — そのまま

コンストラクタの依存:
```typescript
constructor(
  private readonly mrGateway: MrGateway,
  private readonly mrDiscussionGateway: MrDiscussionGateway, // buildPriorContextで使用
  private readonly workflowRunner: ReviewWorkflowRunner,
  private readonly projectTreeGateway: ProjectTreeGateway,
)
```

戻り値の変更点: `ExecuteReviewDto`の代わりに`ReviewExecutionDto`を返す。

```typescript
// 各メソッドの戻り値イメージ
return {
  results,        // ReviewResult[]
  commitHash: mrContext.commitHash,
};
```

**Step 4: index.tsを作成**

```typescript
// src/application/reviewExecution/index.ts
export { ReviewExecutionService } from './ReviewExecutionService.js';
export type { ReviewExecutionCommand } from './ReviewExecutionCommand.js';
export type { ReviewExecutionDto } from './ReviewExecutionDto.js';
```

**Step 5: 失敗するテストを作成**

`ExecuteReviewService`の既存テスト（`src/application/executeReview/__tests__/ExecuteReviewService.test.ts`）を参考に、`ReviewExecutionService`用のテストを作成する。

テスト観点:
- フルレビューが実行され、結果とcommitHashが返却されること
- リトライ時に前回成功結果が保持され、エラー・未レビュー項目のみ再レビューされること
- コメント投稿が呼ばれないこと（責務外）
- 品質ゲート評価が呼ばれないこと（責務外）

**Step 6: テスト実行 — 失敗確認**

```bash
npm run test -- src/application/reviewExecution/__tests__/ReviewExecutionService.test.ts
```

Expected: FAIL

**Step 7: ReviewExecutionServiceを実装**

`ExecuteReviewService`のコードを参考に実装する。コメント投稿・品質ゲート評価のコードは含めない。

**Step 8: テスト実行 — 成功確認**

```bash
npm run test -- src/application/reviewExecution/__tests__/ReviewExecutionService.test.ts
```

Expected: PASS

**Step 9: Commit**

```bash
git add src/application/reviewExecution/
git commit -m "feat: add ReviewExecutionService for API-side AI review execution"
```

---

## Task 3: Application層分割 — CommentPostingService（コメント投稿専用）

**Files:**
- Create: `src/application/commentPosting/CommentPostingCommand.ts`
- Create: `src/application/commentPosting/CommentPostingService.ts`
- Create: `src/application/commentPosting/index.ts`
- Test: `src/application/commentPosting/__tests__/CommentPostingService.test.ts`

**Step 1: CommentPostingCommandを作成**

```typescript
// src/application/commentPosting/CommentPostingCommand.ts
import { ReviewResult } from '../../domain/reviewResult/index.js';
import { Rating } from '../../domain/rating/index.js';
import type { QualityGateResult } from '../../domain/qualityGate/index.js';

export interface CommentPostingCommand {
  projectId: string;
  mrIid: string;
  results: ReviewResult[];
  ratings: Rating[];
  commitHash: string;
  commitMessage: string;
  hiddenRatingLabels: string[];
  qualityGateResult: QualityGateResult;
}
```

**Step 2: CommentPostingServiceを作成**

```typescript
// src/application/commentPosting/CommentPostingService.ts
import type { MrDiscussionGateway } from '../shared/port/gateway/index.js';
import { CommentFormatter } from '../shared/comment/index.js';
import { ReviewResult } from '../../domain/reviewResult/index.js';
import type { CommentPostingCommand } from './CommentPostingCommand.js';

export class CommentPostingService {
  constructor(private readonly mrDiscussionGateway: MrDiscussionGateway) {}

  async execute(command: CommentPostingCommand): Promise<void> {
    const commentBody = CommentFormatter.formatComment(
      command.results,
      command.ratings,
      command.commitHash,
      command.commitMessage,
      command.hiddenRatingLabels,
      command.qualityGateResult,
    );

    if (ReviewResult.allAreHidden(command.results, command.hiddenRatingLabels)) {
      await this.mrDiscussionGateway.postNote(command.projectId, command.mrIid, commentBody);
    } else {
      await this.mrDiscussionGateway.postDiscussion(command.projectId, command.mrIid, commentBody);
    }
  }
}
```

**Step 3: index.tsを作成**

**Step 4: 失敗するテストを作成**

テスト観点:
- コメントがフォーマットされて投稿されること
- 全結果が非表示評定の場合はpostNote、それ以外はpostDiscussionが呼ばれること

**Step 5: テスト実行 — 失敗確認 → 実装 → 成功確認**

```bash
npm run test -- src/application/commentPosting/__tests__/CommentPostingService.test.ts
```

**Step 6: Commit**

```bash
git add src/application/commentPosting/
git commit -m "feat: add CommentPostingService for CLI-side comment posting"
```

---

## Task 4: CLIの改修 — ExecuteReviewServiceを分割後のサービスに置き換え

現在`ExecuteReviewService`が一括で行っている処理を、`ReviewExecutionService`（直接呼び出し、API化前の段階） + `CommentPostingService` + 品質ゲート評価に置き換える。

**この時点ではまだAPI呼び出しには変更しない。** まず内部的にサービス分割を反映し、既存テストが全てパスすることを確認する。

**Files:**
- Modify: `src/index.ts`
- Test: 既存テスト全体

**Step 1: src/index.tsを改修**

`ExecuteReviewService`の代わりに`ReviewExecutionService` + `CommentPostingService`を使用するように変更。

```typescript
// イメージ（概要のみ）
const reviewService = new ReviewExecutionService(mrGateway, mrDiscussionGateway, workflowRunner, treeGateway);
const commentService = new CommentPostingService(mrDiscussionGateway);

// AIレビュー実行
const reviewResult = await reviewService.execute({ ... });

// 全エラーチェック
const allErrors = ReviewResult.allAreErrors(reviewResult.results);

// 品質ゲート評価
const qualityGateResult = reviewSettings.qualityGate.evaluate(reviewResult.results);

// コメント投稿（全エラーでなければ）
if (!allErrors) {
  await commentService.execute({
    projectId, mrIid,
    results: reviewResult.results,
    ratings: reviewSettings.ratings,
    commitHash: reviewResult.commitHash,
    commitMessage: mrContext.commitMessage, // ← MrContextが必要
    hiddenRatingLabels: reviewSettings.hiddenRatingLabels,
    qualityGateResult,
  });
}
```

注意: `commitMessage`はReviewExecutionDtoに含まれていないため、ReviewExecutionDtoに`commitMessage`を追加するか、CLI側でMRコンテキストを取得する必要がある。

→ **ReviewExecutionDtoに`commitMessage`を追加する**のが最もシンプル。

**Step 2: 全テスト実行**

```bash
npm run test
```

Expected: 全テストPASS

**Step 3: Commit**

```bash
git add src/index.ts src/application/reviewExecution/
git commit -m "refactor: replace ExecuteReviewService with split services in CLI"
```

---

## Task 5: Infrastructure — CloneManager

**Files:**
- Create: `src/application/shared/port/clone/CloneManagerPort.ts`
- Create: `src/infrastructure/adapter/clone/CloneManager.ts`
- Create: `src/infrastructure/adapter/clone/index.ts`
- Test: `src/infrastructure/adapter/clone/__tests__/CloneManager.test.ts`

**Step 1: CloneManagerPortを作成**

```typescript
// src/application/shared/port/clone/CloneManagerPort.ts

export interface CloneResult {
  projectDir: string;
  cleanup: () => Promise<void>;
}

export interface CloneManagerPort {
  clone(
    gitlabToken: string,
    projectId: string,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<CloneResult>;
}
```

**Step 2: 失敗するテストを作成**

テスト観点:
- クローンが実行され、projectDirが返却されること
- cleanup()で一時ディレクトリが削除されること
- クローンタイムアウトでエラーになること
- ディスク使用量超過でエラーになること
- 同時クローン数上限でセマフォ待機すること

注意: 実際のgit cloneはテスト環境で実行困難なため、git操作をラップしたヘルパーをモックする。

**Step 3: CloneManagerを実装**

```typescript
// 概要
export class CloneManager implements CloneManagerPort {
  constructor(
    private readonly gitlabApiBaseUrl: string,
    private readonly cloneTimeoutMs: number,
    private readonly reviewTimeoutMs: number,
    private readonly maxDiskMb: number,
    private readonly maxConcurrentClones: number,
  ) {}

  async clone(gitlabToken, projectId, sourceBranch, targetBranch): Promise<CloneResult> {
    // 1. セマフォ取得（待機 + タイムアウト）
    // 2. 一時ディレクトリ作成
    // 3. git clone --filter=blob:none --no-checkout (タイムアウト付き)
    // 4. git fetch origin targetBranch sourceBranch
    // 5. git checkout sourceBranch
    // 6. ディスクサイズチェック
    // 7. CloneResult返却（cleanup関数付き）
  }
}
```

**Step 4: テスト実行 — 成功確認**

```bash
npm run test -- src/infrastructure/adapter/clone/__tests__/CloneManager.test.ts
```

**Step 5: Commit**

```bash
git add src/application/shared/port/clone/ src/infrastructure/adapter/clone/
git commit -m "feat: add CloneManager for API-side repository cloning"
```

---

## Task 6: Infrastructure — JWT認証ミドルウェア

**Files:**
- Create: `src/infrastructure/adapter/auth/JwtAuthMiddleware.ts`
- Create: `src/infrastructure/adapter/auth/index.ts`
- Test: `src/infrastructure/adapter/auth/__tests__/JwtAuthMiddleware.test.ts`

**Step 1: 失敗するテストを作成**

テスト観点:
- 有効なJWTでリクエストが通過すること
- JWT未指定で401エラーになること
- 無効な署名で401エラーになること
- 期限切れJWTで401エラーになること
- audience不一致で401エラーになること

`jose`の`generateKeyPair`でテスト用キーペアを生成し、テスト用JWKSサーバーをモックする。

**Step 2: JwtAuthMiddlewareを実装**

```typescript
// 概要
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';

export function createJwtAuthMiddleware(config: {
  jwksUrl: string;
  audience: string;
  issuer: string;
}): MiddlewareHandler {
  const JWKS = createRemoteJWKSet(new URL(config.jwksUrl));

  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const { payload } = await jwtVerify(token, JWKS, {
        audience: config.audience,
        issuer: config.issuer,
      });
      c.set('jwtPayload', payload);
      await next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  };
}
```

**Step 3: テスト実行 — 成功確認**

```bash
npm run test -- src/infrastructure/adapter/auth/__tests__/JwtAuthMiddleware.test.ts
```

**Step 4: Commit**

```bash
git add src/infrastructure/adapter/auth/
git commit -m "feat: add JWT authentication middleware using jose"
```

---

## Task 7: Infrastructure — RateLimiter（ラウンドロビン + TokenBucket）

**Files:**
- Create: `src/application/shared/port/rateLimiter/RateLimiterPort.ts`
- Create: `src/infrastructure/adapter/rateLimiter/RateLimiter.ts`
- Create: `src/infrastructure/adapter/rateLimiter/index.ts`
- Test: `src/infrastructure/adapter/rateLimiter/__tests__/RateLimiter.test.ts`

**Step 1: RateLimiterPortを作成**

```typescript
// src/application/shared/port/rateLimiter/RateLimiterPort.ts
export interface RateLimiterPort {
  /**
   * API呼び出し許可を取得する。上限到達時は待機する。
   * @param userId リクエスト元のユーザーID（ラウンドロビン用）
   */
  acquirePermission(userId: string): Promise<void>;

  /**
   * 429エラーを報告する。全ユーザーの発行を一時停止する。
   */
  reportRateLimit(): void;

  /**
   * API呼び出し成功を報告する。
   */
  reportSuccess(): void;

  /**
   * ユーザーセッションを登録する。
   */
  registerUser(userId: string): void;

  /**
   * ユーザーセッションを解除する。
   */
  unregisterUser(userId: string): void;
}
```

**Step 2: 失敗するテストを作成**

テスト観点:
- 1分間のレート制限内でAPI呼び出しが許可されること
- レート制限超過時に待機すること
- 複数ユーザーがラウンドロビンで公平に発行権を得ること
- 429報告時に全ユーザーが一時停止すること
- 429後の待機が指数バックオフ + ジッターであること
- 成功報告でretryCountがリセットされること

**Step 3: RateLimiterを実装**

既存の`RateLimitCoordinator`のパターンを参考に、TokenBucket + RoundRobinScheduler + GlobalThrottlerを統合して実装する。

**Step 4: テスト実行 — 成功確認**

```bash
npm run test -- src/infrastructure/adapter/rateLimiter/__tests__/RateLimiter.test.ts
```

**Step 5: Commit**

```bash
git add src/application/shared/port/rateLimiter/ src/infrastructure/adapter/rateLimiter/
git commit -m "feat: add RateLimiter with round-robin scheduling and token bucket"
```

---

## Task 8: APIサーバー — Honoルート + SSEレスポンス

**Files:**
- Create: `src/server.ts`
- Create: `src/presentation/api/reviewRoute.ts`
- Create: `src/presentation/api/index.ts`
- Test: `src/presentation/api/__tests__/reviewRoute.test.ts`

**Step 1: リクエスト/レスポンスのスキーマ定義**

Zodスキーマでリクエストバリデーションを定義:

```typescript
// src/presentation/api/reviewRoute.ts 内
import { z } from 'zod';

const reviewRequestSchema = z.object({
  gitlabToken: z.string().min(1),
  projectId: z.string().min(1),
  mrIid: z.string().min(1),
  checklist: z.array(z.string().min(1)).min(1),
  reviewSettings: z.object({
    additionalInstructions: z.string().optional().default(''),
    concurrentReviewCount: z.number().nullable().optional().default(null),
    commentFormat: z.string().optional().default('{comment}'),
    ratings: z.array(z.object({
      label: z.string(),
      definition: z.string(),
    })).optional(),
    hiddenRatingLabels: z.array(z.string()).optional().default([]),
    qualityGate: z.object({
      failureCriteria: z.array(z.object({
        ratingLabel: z.string(),
        threshold: z.number(),
      })).optional().default([]),
    }).optional(),
  }).optional(),
  options: z.object({
    commentLanguage: z.string().optional().default('Japanese'),
    skillsPaths: z.array(z.string()).optional().default([]),
    treeMaxDepth: z.number().optional(),
    maxContextLength: z.number().nullable().optional().default(null),
  }).optional(),
});
```

**Step 2: SSEレスポンスハンドラを実装**

```typescript
// 概要: POST /api/v1/review
// 1. リクエストバリデーション
// 2. CloneManager.clone()
// 3. DI組み立て（クローンされたprojectDirを使用）
// 4. ReviewExecutionService.execute()
//    - 進捗イベントはコールバックでSSEに流す
// 5. SSE event: result でレビュー結果を返却
// 6. finally: クリーンアップ
```

**Step 3: server.tsを作成**

```typescript
// src/server.ts
import { Hono } from 'hono';
import { createJwtAuthMiddleware } from './infrastructure/adapter/auth/index.js';
import { reviewRoute } from './presentation/api/index.js';

const app = new Hono();

// JWT認証ミドルウェア
app.use('/api/*', createJwtAuthMiddleware({
  jwksUrl: process.env['JWT_JWKS_URL']!,
  audience: process.env['JWT_AUDIENCE']!,
  issuer: process.env['JWT_ISSUER']!,
}));

// ヘルスチェック（認証不要）
app.get('/health', (c) => c.json({ status: 'ok' }));

// レビューAPI
app.route('/api/v1', reviewRoute);

// サーバー起動
const port = Number(process.env['API_PORT'] ?? '3000');
console.log(`Starting server on port ${port}`);
export default { port, fetch: app.fetch };
```

**Step 4: 失敗するテストを作成**

テスト観点:
- 有効なリクエストでSSEレスポンスが返却されること
- バリデーションエラーで400が返却されること
- SSEイベントにprogress, result, keepaliveが含まれること
- エラー時にevent: errorが返却されること
- ヘルスチェックが200を返すこと

HonoのテストヘルパーでHTTPリクエストをモック。ReviewExecutionService等はモック。

**Step 5: テスト実行 → 実装 → テスト成功**

```bash
npm run test -- src/presentation/api/__tests__/reviewRoute.test.ts
```

**Step 6: Commit**

```bash
git add src/server.ts src/presentation/
git commit -m "feat: add Hono API server with SSE review endpoint"
```

---

## Task 9: Infrastructure — ReviewApiClient（CLI→API呼び出し）

CLI側からAPIサーバーを呼び出すSSEクライアントを実装する。

**Files:**
- Create: `src/infrastructure/adapter/apiClient/ReviewApiClient.ts`
- Create: `src/infrastructure/adapter/apiClient/index.ts`
- Test: `src/infrastructure/adapter/apiClient/__tests__/ReviewApiClient.test.ts`

**Step 1: ReviewApiClientを作成**

```typescript
// 概要
export class ReviewApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly jwtToken: string,
  ) {}

  /**
   * レビューAPIを呼び出し、SSEレスポンスを処理する
   * @param request リクエストボディ
   * @param onProgress 進捗コールバック
   * @returns レビュー結果
   */
  async executeReview(
    request: ReviewApiRequest,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<ReviewApiResponse> {
    // 1. fetch() でPOST /api/v1/review にリクエスト
    // 2. SSEレスポンスをパース
    //    - event: progress → onProgressコールバック
    //    - event: keepalive → 無視
    //    - event: result → 結果を返却
    //    - event: error → エラースロー
  }
}
```

**Step 2: 失敗するテストを作成**

テスト観点:
- SSEレスポンスを正しくパースできること
- progressイベントでコールバックが呼ばれること
- resultイベントでレビュー結果が返却されること
- errorイベントでエラーがスローされること
- 接続エラー時に適切なエラーメッセージが返ること

**Step 3: 実装 → テスト成功**

```bash
npm run test -- src/infrastructure/adapter/apiClient/__tests__/ReviewApiClient.test.ts
```

**Step 4: Commit**

```bash
git add src/infrastructure/adapter/apiClient/
git commit -m "feat: add ReviewApiClient for CLI-to-API SSE communication"
```

---

## Task 10: CLIの改修 — API呼び出しに切り替え

CLI側の`src/index.ts`を改修し、`ReviewExecutionService`の直接呼び出しをAPIクライアント呼び出しに置き換える。

**Files:**
- Modify: `src/index.ts`
- Modify: `src/lib/cli.ts`
- Test: 既存テスト + 統合テスト

**Step 1: cli.tsに`AIKATA_API_URL`オプションを追加**

```typescript
// --aikata-api-url / AIKATA_API_URL を追加
// AIKATA_JWT環境変数（GitLab id_tokensで自動設定）の読み取りも追加
```

**Step 2: src/index.tsを改修**

```typescript
// 概要
// AIKATA_API_URLが設定されている場合 → APIクライアント経由
// AIKATA_API_URLが未設定の場合 → 従来通りローカル実行（後方互換、開発用）

if (apiUrl) {
  // APIモード
  const client = new ReviewApiClient(apiUrl, jwtToken);
  const apiResult = await client.executeReview({
    gitlabToken,
    projectId,
    mrIid,
    checklist: checklist.items.map(i => i.content),
    reviewSettings: { ... },
    options: { ... },
  }, (event) => logger.info(event, 'Progress'));

  // レビュー結果をReviewResult[]に変換
  // コメント投稿
  // 品質ゲート評価
} else {
  // ローカルモード（既存動作）
}
```

**Step 3: テスト実行**

```bash
npm run test
```

Expected: 全テストPASS

**Step 4: Commit**

```bash
git add src/index.ts src/lib/cli.ts
git commit -m "feat: switch CLI to use API client when AIKATA_API_URL is set"
```

---

## Task 11: RateLimiterをAPIサーバーに統合

**Files:**
- Modify: `src/presentation/api/reviewRoute.ts`
- Modify: `src/server.ts`

**Step 1: reviewRoute内でRateLimiterを利用するように改修**

APIサーバーのreviewRouteのハンドラ内で、Mastra workflow実行前にRateLimiterを統合する。具体的には:

- リクエスト受信時に`registerUser(userId)`
- `withRateLimitRetry`のコーディネーターとしてRateLimiterを設定
- リクエスト完了時に`unregisterUser(userId)`

**Step 2: server.tsでRateLimiterの初期化を追加**

環境変数`AI_API_RATE_LIMIT_PER_MIN`からRateLimiterを初期化。

**Step 3: テスト実行**

```bash
npm run test
```

**Step 4: Commit**

```bash
git add src/presentation/api/ src/server.ts
git commit -m "feat: integrate RateLimiter into API server review route"
```

---

## Task 12: ビルド設定の更新

**Files:**
- Modify: `build.ts`
- Modify: `package.json`

**Step 1: build.tsにserver.tsのビルドを追加**

```typescript
// 2つのエントリーポイントをビルド
// CLI用: src/index.ts → dist/index.js
// API用: src/server.ts → dist/server.js

await build({
  entryPoints: ['src/index.ts'],
  // ...既存設定
});

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/server.js',
  banner: { js: bannerLines },
  packages: 'external',
  minify: false,
  sourcemap: true,
});
```

**Step 2: package.jsonにbuild:serverスクリプトを追加**

```json
{
  "scripts": {
    "build:cli": "npx tsx build.ts",
    "build:server": "npx tsx build.ts"
  }
}
```

注意: build.tsが両方ビルドするので同一コマンドでOK。あるいは分離する場合はbuild.tsを引数対応にする。

**Step 3: ビルド確認**

```bash
npm run build:cli
ls -la dist/index.js dist/server.js
```

Expected: 両ファイルが生成される

**Step 4: Commit**

```bash
git add build.ts package.json
git commit -m "feat: add server.ts build output to esbuild config"
```

---

## Task 13: Docker構成

**Files:**
- Create: `docker/prod/Dockerfile`
- Create: `docker/prod/docker-compose.yml`

**Step 1: Dockerfileを作成**

```dockerfile
FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY dist/server.js .
COPY dist/server.js.map .
COPY node_modules/ ./node_modules/

EXPOSE 3000

CMD ["node", "server.js"]
```

**Step 2: docker-compose.ymlを作成**

設計書セクション5の内容を反映。

**Step 3: ビルド確認**

```bash
cd docker/prod && docker compose build
```

**Step 4: Commit**

```bash
git add docker/
git commit -m "feat: add Dockerfile and docker-compose for API server"
```

---

## Task 14: 環境変数・設定ファイルの更新

**Files:**
- Modify: `.env.example`
- Modify: `.ci-template/variable/variables.yml`
- Modify: `docs/config/env_val.md`

**Step 1: .env.exampleを更新**

CLI側:
```
# API
AIKATA_API_URL=
```

APIサーバー側の環境変数例も追記:
```
# === API Server ===
# JWT_JWKS_URL=
# JWT_AUDIENCE=
# JWT_ISSUER=
# AI_API_RATE_LIMIT_PER_MIN=60
# MAX_CONCURRENT_CLONES=5
# CLONE_TIMEOUT_MS=300000
# REVIEW_TIMEOUT_MS=3600000
# CLONE_MAX_DISK_MB=1024
# API_PORT=3000
```

**Step 2: variables.ymlを更新**

```yaml
AIKATA_API_URL: ""
```

**Step 3: env_val.mdを更新**

新規環境変数のドキュメントを追加。

**Step 4: Commit**

```bash
git add .env.example .ci-template/variable/variables.yml docs/config/env_val.md
git commit -m "docs: update environment variable configuration for API externalization"
```

---

## Task 15: CIテンプレートの更新

**Files:**
- Modify: `.ci-template/pipelines/template.yml`

**Step 1: id_tokensの追加**

```yaml
aikata-pr-review:
  id_tokens:
    AIKATA_JWT:
      aud: "${AIKATA_API_URL}"
  # ...既存のscriptはそのまま
```

注意: `aikata-pr`コマンド自体はそのまま。CLIが内部的に`AIKATA_API_URL`と`AIKATA_JWT`環境変数を使ってAPIを呼び出す。

**Step 2: 不要なAI関連変数のコメントアウトまたは削除**

`AI_API_KEY`, `AI_API_ENDPOINT_URL`, `AI_MODEL_NAME`はAPIサーバー側で管理するため、利用者側では不要になる。ただし後方互換のためすぐに削除せず、コメントで非推奨を明示する。

**Step 3: Commit**

```bash
git add .ci-template/
git commit -m "feat: add id_tokens JWT support to CI template"
```

---

## Task 16: 全体統合テスト + リファクタリング

**Step 1: 全テスト実行**

```bash
npm run test
```

Expected: 全テストPASS

**Step 2: lint + format**

```bash
npm run lint:fix
npm run format
```

**Step 3: ビルド確認**

```bash
npm run build:cli
```

**Step 4: 型エラー確認**

```bash
npx tsc --noEmit
```

**Step 5: カバレッジ確認**

```bash
npm run test:coverage
```

新規実装部分のカバレッジが80%以上であることを確認。

**Step 6: Commit**

```bash
git add .
git commit -m "chore: fix lint, format, and ensure full test coverage"
```

---

## タスク依存関係

```
Task 1 (依存追加)
  ├── Task 2 (ReviewExecutionService)
  ├── Task 3 (CommentPostingService)
  │     └── Task 4 (CLI分割反映) ← Task 2, 3の両方に依存
  ├── Task 5 (CloneManager)
  ├── Task 6 (JWT middleware)
  ├── Task 7 (RateLimiter)
  │
  └── Task 8 (Honoサーバー) ← Task 2, 5, 6に依存
        ├── Task 9 (ReviewApiClient)
        │     └── Task 10 (CLI API切替) ← Task 4, 9に依存
        └── Task 11 (RateLimiter統合) ← Task 7, 8に依存
              │
              Task 12 (ビルド設定) ← Task 8に依存
              Task 13 (Docker) ← Task 12に依存
              Task 14 (環境変数) ← Task 10に依存
              Task 15 (CIテンプレート) ← Task 14に依存
              Task 16 (統合テスト) ← 全タスクに依存
```
