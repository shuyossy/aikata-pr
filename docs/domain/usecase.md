# ユースケース
記載フォーマット
```
- ユースケース名
  - 識別子: [英語で記載、実装するクラス名と同じにする] ※~Serviceとすること
  - 前提条件
    - [箇条書き]
  - 入力: [入力内容を簡潔に記載]
  - 出力: [出力内容を簡潔に記載]
  - メインフロー
    1. [番号付き箇条書き]
  - 例外
    - パターン1: [条件を記載]
      - [結果(アクション)を箇条書き]
    - パターン2: ...
  - 事後処理
    - [事後処理があれば箇条書きで記載]
```

---

- レビュー実行
  - 識別子: ExecuteReviewService
  - 前提条件
    - GitLab APIトークンが有効
    - AI APIキーとエンドポイントが有効
    - チェックリストが提供済み
  - 入力: ExecuteReviewCommand（userId, projectId, mrIid, checklist, reviewSettings, skillsPaths, aiApiKey, aiApiEndpointUrl, aiModelName, gitlabToken）
  - 出力: ExecuteReviewDto（results, commitHash, commentPosted）
  - メインフロー
    1. MRコンテキストを取得（MrGateway）
    2. MRの既存コメントを取得（MrCommentGateway）
    3. 最新のaikataレビューコメントをパースして前回レビューコンテキストを構築
    4. レビューワークフローを実行（チェックリスト分割→レビュー実行）
    5. レビュー結果をMarkdownコメントとして整形
    6. MRにコメントを投稿
  - 例外
    - パターン1: GitLab API認証エラー
      - エラーをスロー
    - パターン2: AI API実行エラー
      - 該当チェック項目のレビュー結果をエラーとして処理
  - 事後処理
    - なし
