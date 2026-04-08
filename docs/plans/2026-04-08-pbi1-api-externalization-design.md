# PBI #1: MRチェックコアロジックのAPI化 — アーキテクチャ設計

## 概要

MRチェックのAI処理部分を外部HTTP APIとして切り出し、AI APIキーの流出リスクを排除する。
利用者のCI/CDジョブからはJWT認証付きでAPIを呼び出し、AI APIキーはAPIサーバー側で一元管理する。

## 設計方針

- **アプローチ**: プレゼンテーション層の差し替え + Application層のサービス分割
- **API化対象**: AI処理部分のみ（GitLab操作はCI/CDジョブ側CLIに残す）
- **既存CLIは維持**: CIテンプレート変更不要。CLIがAI処理を外部API呼び出しに委譲する形に改修

---

## 1. 全体アーキテクチャ

### システム構成図

```
CI/CDジョブ (Docker) — CIテンプレート変更なし
  │
  └── aikata-pr CLI
        1. チェックリストCSV読み込み
        2. レビュー設定JSON読み込み
        3. 外部APIへリクエスト送信（SSE）
        4. レビュー結果を受信
        5. コメントフォーマット・投稿（GitLab API）
        6. 品質ゲート評価 → exit code
              │ HTTPS
        ┌─────▼─────┐
        │  HAProxy   │ (HTTPS終端、既存)
        └─────┬─────┘
              │ HTTP
        ┌─────▼──────────────────────────────┐
        │  Hono API Server (Docker)           │
        │                                     │
        │  Presentation層                     │
        │  ├── POST /api/v1/review (SSE)      │
        │  ├── JWT認証ミドルウェア             │
        │  └── リクエストバリデーション         │
        │                                     │
        │  Application層                      │
        │  └── ReviewExecutionService          │
        │      (AI処理に特化)                  │
        │                                     │
        │  Infrastructure層                   │
        │  ├── CloneManager (clone/cleanup)    │
        │  ├── RateLimiter (ラウンドロビン)     │
        │  ├── GitLabMrGateway (既存)          │
        │  ├── LocalGitDiffMrGateway (既存)    │
        │  └── LocalProjectTreeGateway (既存)  │
        │                                     │
        │  Mastra層 (既存)                     │
        │  └── reviewWorkflow                 │
        └─────────────────────────────────────┘
```

### Application層のサービス分割

現在の`ExecuteReviewService`を以下に分割:

| サービス | 責務 | 配置 |
|---|---|---|
| `ReviewExecutionService` (新) | MRコンテキスト取得 + AIレビュー実行 | APIサーバー側 |
| `CommentPostingService` (切り出し) | レビュー結果のフォーマット + GitLab投稿 | CLI側 |
| 品質ゲート評価 | `QualityGate.evaluate()` を直接呼び出し | CLI側（ドメイン層のロジックを利用） |

### エンドポイント設計

**`POST /api/v1/review`**

リクエストボディ:
```json
{
  "gitlabToken": "<利用者が設定したトークン>",
  "projectId": "123",
  "mrIid": "45",
  "checklist": ["チェック項目1", "チェック項目2"],
  "reviewSettings": {
    "additionalInstructions": "...",
    "concurrentReviewCount": 3,
    "commentFormat": "{comment}",
    "ratings": [{"label": "A", "definition": "..."}],
    "hiddenRatingLabels": ["A"],
    "qualityGate": {"failureCriteria": []}
  },
  "options": {
    "commentLanguage": "Japanese",
    "skillsPaths": [],
    "treeMaxDepth": 3,
    "maxContextLength": null
  }
}
```

SSEレスポンス:
```
event: progress
data: {"status": "cloning", "message": "Cloning repository..."}

event: progress
data: {"status": "reviewing", "message": "Reviewing 3/10 items..."}

event: keepalive
data: {}

event: result
data: {"results": [...], "commitHash": "abc123"}

event: error
data: {"code": "REVIEW_FAILED", "message": "..."}
```

---

## 2. JWT認証

### 概要

GitLab CI/CDの`id_tokens`で発行されるJWTを、`jose`ライブラリでアプリケーション内検証する。

### 検証フロー

```
CI/CDジョブ
  id_tokens:
    AIKATA_JWT:
      aud: "https://<api-server-host>"
               │
               ▼ Authorization: Bearer <JWT>
Hono JWTミドルウェア
  1. JWKSエンドポイントからGitLabの公開鍵を取得（joseが自動キャッシュ）
     GET <JWT_JWKS_URL>
  2. 署名検証
  3. クレーム検証（aud, iss, exp）
  4. OK → リクエスト処理 / NG → 401レスポンス
```

### 環境変数

| 変数名 | 説明 |
|---|---|
| `JWT_JWKS_URL` | GitLabのJWKSエンドポイントURL |
| `JWT_AUDIENCE` | 期待するaudience値 |
| `JWT_ISSUER` | 期待するissuer値（GitLabインスタンスURL） |

### 実装方針

- `jose`ライブラリの`createRemoteJWKSet` + `jwtVerify`を使用
- Infrastructure層に`JwtAuthMiddleware`として配置
- Honoのミドルウェアとしてルートに適用

---

## 3. CloneManager（リポジトリクローン管理）

### 責務

リクエストごとにリポジトリをクローンし、処理完了後に確実に削除する。

### 処理フロー

```
1. 一時ディレクトリ作成（/tmp/aikata-pr-<uuid>/）
2. git clone 実行
   - AIKATA_PR_GITLAB_TOKEN（リクエストボディから取得）を使用した認証付きclone
   - MR関連履歴の取得:
     git clone --filter=blob:none --no-checkout <repo-url> <dir>
     git fetch origin <target-branch> <source-branch>
     git checkout <source-branch>
3. クローン完了 → パスを返却し、レビュー処理開始
4. 処理完了（成功・失敗問わず）→ try/finallyで一時ディレクトリを削除
```

### ガードレール

| ガードレール | 設計 |
|---|---|
| クローンタイムアウト | 環境変数`CLONE_TIMEOUT_MS`（デフォルト: 300,000ms = 5分） |
| レビュー全体タイムアウト | 環境変数`REVIEW_TIMEOUT_MS`（デフォルト: 3,600,000ms = 60分） |
| ディスク使用量上限 | 環境変数`CLONE_MAX_DISK_MB`（デフォルト: 1024MB）。クローン後にサイズチェック |
| 確実なクリーンアップ | try/finallyで削除。プロセス終了時のシグナルハンドラでも削除 |
| 同時クローン数上限 | 環境変数`MAX_CONCURRENT_CLONES`（デフォルト: 5）。セマフォで制御。上限到達時は空くまで待機（`REVIEW_TIMEOUT_MS`以内）、タイムアウト時は503エラー |

### 配置

- Infrastructure層: `src/infrastructure/adapter/clone/CloneManager.ts`
- Application層にポート定義: `CloneManagerPort`

---

## 4. AI APIレート制御

### 概要

複数ユーザーのレビューが同時実行される際、AI APIの発行回数を制御し、特定ユーザーに偏らない公平なアクセスを実現する。

### コンポーネント構成

```
RateLimiter
  ├── TokenBucket — 1分間の発行回数を管理
  ├── RoundRobinScheduler — ユーザーごとのキューから順番に発行権を付与
  └── GlobalThrottler — 429検知時に全ユーザー一時停止
```

### 動作フロー

**通常時:**
```
User A: [req1] [req3] [req5] ...
User B: [req2] [req4] [req6] ...
         ↓
RoundRobin: A → B → A → B → ...
         ↓
TokenBucket: 1分間の上限内なら発行許可、上限到達なら次の1分まで待機
         ↓
AI API呼び出し
```

**429エラー検知時:**
```
AI API → 429 Too Many Requests
         ↓
GlobalThrottler: 全ユーザーの発行を一時停止
待機時間: 指数バックオフ + ジッター（既存のcalculateBackoffDelay準拠）
  delay = min(baseDelayMs × 2^retryCount + random(0, baseDelayMs), maxDelayMs)
         ↓
待機完了後: ラウンドロビン順を維持して再開
成功応答: retryCountリセット
リトライ上限到達: エラー
```

### 既存コードとの関係

既存の`RateLimitCoordinator`のグローバル制御パターンを拡張し、ラウンドロビンスケジューリングとTokenBucketを追加する形で統合する。

### 環境変数

| 変数名 | 説明 | デフォルト |
|---|---|---|
| `AI_API_RATE_LIMIT_PER_MIN` | 1分間あたりのAI API発行上限 | 60 |

### 配置

- Infrastructure層: `src/infrastructure/adapter/rateLimiter/RateLimiter.ts`
- Application層にポート定義: `RateLimiterPort`

---

## 5. ビルド・デプロイ構成

### ビルド成果物

| 成果物 | 用途 | エントリーポイント |
|---|---|---|
| `dist/index.js` | CLI（CI/CDジョブ内で実行） | `src/index.ts`（改修） |
| `dist/server.js` | APIサーバー | `src/server.ts`（新規） |

### Dockerファイル構成

```
docker/prod/
  ├── Dockerfile          # APIサーバー用
  └── docker-compose.yml  # APIサーバー起動用
```

### docker-compose.yml

```yaml
services:
  aikata-pr-api:
    build:
      context: ../..
      dockerfile: docker/prod/Dockerfile
    ports:
      - "${API_PORT:-3000}:3000"
    environment:
      - AI_API_KEY
      - AI_API_ENDPOINT_URL
      - AI_MODEL_NAME
      - JWT_JWKS_URL
      - JWT_AUDIENCE
      - JWT_ISSUER
      - AI_API_RATE_LIMIT_PER_MIN
      - MAX_CONCURRENT_CLONES
      - CLONE_TIMEOUT_MS
      - REVIEW_TIMEOUT_MS
      - AIKATA_LOG_LEVEL
    volumes:
      - /tmp/aikata-pr-clones:/tmp/aikata-pr-clones
```

---

## 6. 環境変数の変更まとめ

### 利用者側（CI/CDジョブ）の変更

| 変数 | 変更 |
|---|---|
| `AIKATA_API_URL` | **新規追加** — APIサーバーのURL |
| `AI_API_KEY` | **不要になる** — APIサーバー側で管理 |
| `AI_API_ENDPOINT_URL` | **不要になる** — APIサーバー側で管理 |
| `AI_MODEL_NAME` | **不要になる** — APIサーバー側で管理 |
| `AIKATA_PR_GITLAB_TOKEN` | **変更なし** — リクエストボディに含めて送信 |
| その他（`CHECKLIST_PATH`等） | **変更なし** |

### APIサーバー側（docker-compose環境変数）

| 変数名 | 説明 |
|---|---|
| `AI_API_KEY` | AI APIキー（一元管理） |
| `AI_API_ENDPOINT_URL` | AI APIエンドポイント |
| `AI_MODEL_NAME` | AIモデル名 |
| `JWT_JWKS_URL` | GitLab JWKSエンドポイントURL |
| `JWT_AUDIENCE` | JWT audience値 |
| `JWT_ISSUER` | JWT issuer値 |
| `AI_API_RATE_LIMIT_PER_MIN` | AI API発行上限/分 |
| `MAX_CONCURRENT_CLONES` | 同時クローン数上限 |
| `CLONE_TIMEOUT_MS` | クローンタイムアウト |
| `REVIEW_TIMEOUT_MS` | レビュー全体タイムアウト |
| `CLONE_MAX_DISK_MB` | クローンディスク使用量上限 |
| `AIKATA_LOG_LEVEL` | ログレベル |

### セキュリティ改善

```
Before: AI_API_KEY が各利用者のCI/CD変数に設定 → 流出リスク
After:  AI_API_KEY はAPIサーバーのみ → 利用者から不可視
        利用者認証はGitLab JWT (id_tokens) → 短命トークンで安全
```

---

## 技術選定サマリ

| 項目 | 選定 | 理由 |
|---|---|---|
| HTTPフレームワーク | Hono | TypeScriptファースト、軽量、Mastra親和性 |
| JWT検証 | jose（アプリ内ミドルウェア） | 単一サービスにEnvoyはオーバースペック |
| レスポンス形式 | SSE | 長時間処理の接続維持、ポーリングより実装がシンプル |
| デプロイ | Docker + docker-compose | オンプレ、HAProxy(HTTPS終端)の後段 |
