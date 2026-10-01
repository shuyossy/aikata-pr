# aikata-pr

GitLabのマージリクエスト（MR）に対して、AIがチェックリストに沿ったレビューを自動実行するCI/CDパイプラインテンプレートです。

## 特徴

- チェックリスト（CSV形式またはMarkdownテーブル形式）に定義した観点でMRを自動レビュー
- レビュー結果をMRのディスカッションにコメントとして自動投稿
- 評定基準・コメントフォーマット・レビュー言語のカスタマイズが可能

## クイックスタート

### 1. CIテンプレートの設定

対象プロジェクトの`.gitlab-ci.yml`に以下を追加します。

```yaml
include:
  - project: '<aikata-prプロジェクトのパス>'
    file: '.ci-template/pipelines/template.yml'
```

### 2. CI/CD変数の設定

GitLabプロジェクトの **設定 > CI/CD > 変数** から以下を設定します。

| 変数名 | 説明 |
|--------|------|
| `AI_API_KEY` | AIモデルのAPIキー |
| `AI_API_ENDPOINT_URL` | AIモデルのAPIエンドポイントURL |
| `AI_MODEL_NAME` | 使用するAIモデル名 |
| `AIKATA_PR_GITLAB_TOKEN` | GitLab APIトークン（apiスコープ） |
| `CHECKLIST_PATH` | チェックリストファイルのパス |
| `AIKATA_IMAGE` | aikata-prのDockerイメージ |

### 3. チェックリストの作成

プロジェクト内にチェックリストファイル（CSV形式、または拡張子`.md`のMarkdownテーブル形式）を配置します。

```csv
コードの可読性が十分か
テストが適切に記述されているか
セキュリティ上の問題がないか
エラーハンドリングが適切か
```

MRを作成すると、AIが自動的にレビューを実行し、結果をコメントとして投稿します。

## ドキュメント

詳細な設定方法や活用のヒントについては[記事](docs/guide/user-guide.md)を参照してください。
