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

- AIレビュー実行
  - 識別子: ReviewExecutionService
  - 前提条件
    - GitLab APIトークンが有効
    - AI APIキーとエンドポイントが有効
    - チェックリストが提供済み
  - 入力: ReviewExecutionCommand（userId, projectId, mrIid, gitlabToken, checklist, reviewSettings, skillsPaths, projectDir, aiApiKey, aiApiEndpointUrl, aiModelName, treeMaxDepth, commentLanguage, openaiReasoningEffort, maxContextLength）
  - 出力: ReviewExecutionDto（results, commitHash, commitMessage）
  - メインフロー
    1. MRコンテキストを取得（MrGateway）
       - MR diffはローカルgitリポジトリから優先取得し、失敗時はGitLab API（access_raw_diffs=true）にフォールバック
    2. MRの既存ディスカッションを取得（MrDiscussionGateway）
    3. 最新のaikataレビューコメントをパースして前回レビューコンテキストを構築
    3.5. 前回レビューのコミットハッシュと今回のコミットハッシュが一致する場合（パイプラインリトライ）:
       - 前回の成功結果をそのまま保持する
       - エラー項目＋前回結果にない項目のみレビューワークフローで再レビュー
       - 再レビュー対象がない場合は前回結果をそのまま返却して終了
       - 再レビュー結果と保持結果をマージして返却
    4. レビューワークフローを実行（チェックリスト分割→レビュー実行）
    5. レビュー結果を返却（コメント投稿・品質ゲート評価はこのサービスの責務外）
  - 例外
    - パターン1: GitLab API認証エラー
      - エラーをスロー
    - パターン2: コンテキスト長エラー
      - 作業履歴を要約Agentで要約し、新しいスレッドでレビューを継続する
      - 継続レビューでも再度コンテキスト長エラーが発生した場合は、要約→継続をループする（最大3回）
      - 既にストア済みの成功結果は保持する
    - パターン3: API呼び出しエラー（コンテキスト長以外）
      - 既にストア済みの成功結果は保持する
      - 未完了チェック項目のレビュー結果にエラー内容を表示する
    - パターン4: その他のエラー
      - 既にストア済みの成功結果は保持する
      - 未完了チェック項目のレビュー結果に「予期せぬエラー（実行ログを確認してください）」を表示する
  - 事後処理
    - なし

- コメント投稿
  - 識別子: CommentPostingService
  - 前提条件
    - レビュー結果が存在すること
  - 入力: CommentPostingCommand（projectId, mrIid, results, ratings, commitHash, commitMessage, hiddenRatingLabels, qualityGateResult）
  - 出力: void
  - メインフロー
    1. レビュー結果をMarkdownコメントとして整形（品質ゲート結果を含む）
    2. MRにコメントを投稿
       - 全結果が非表示評定ラベルに該当する場合はノート（通常コメント）として投稿
       - それ以外はディスカッションとして投稿
  - 例外
    - パターン1: GitLab API認証エラー
      - エラーをスロー
  - 事後処理
    - なし
  - 備考
    - 品質ゲート評価（QualityGate.evaluate）およびジョブの成否判定（全エラー時・品質ゲート抵触時のexit code 1）はreviewサブコマンドのエントリ（src/cli/review/index.ts）で実行される

- サジェスト生成
  - 識別子: ReviewExecutionService（既存サービスの拡張）
  - 前提条件
    - suggestEnabledRatingLabelsが空でないこと
  - 入力: ReviewExecutionCommand（既存フィールド + suggestEnabledRatingLabels）
  - 出力: ReviewExecutionDto（既存フィールド + suggestions）
  - メインフロー
    1. MRの既存ディスカッションからaikataマーカー付きのsuggest discussionを取得する
    2. 有効なsuggest（unresolve & チェックリスト内 & diff未更新）と自動resolve対象を算出する
    3. 有効なsuggestをあらかじめストアに登録する
    4. レビューワークフロー実行時、suggestが有効な評定のチェック項目に対してAgentがstoreSuggestツールでsuggestを登録する
    5. レビュー結果と共にsuggestを返却する
  - 例外
    - パターン1: suggestEnabledRatingLabelsにratingsに存在しないラベルが含まれる場合
      - エラーをスロー
  - 事後処理
    - なし

- サジェスト投稿
  - 識別子: CommentPostingService（既存サービスの拡張）
  - 前提条件
    - suggestが存在すること
  - 入力: CommentPostingCommand（既存フィールド + suggestions, suggestsToResolve, diff）
  - 出力: void
  - メインフロー
    1. 自動resolve対象のsuggest discussionをresolveする
    2. 各suggestのoriginalCodeをdiffから検索し、行番号を解決する（ResolvedSuggestion）
    3. 解決済みsuggestをGitLab MRにdiff discussionとして投稿する
  - 例外
    - パターン1: 行番号解決に失敗した場合
      - 当該suggestをスキップし、警告ログを出力する
  - 事後処理
    - なし
