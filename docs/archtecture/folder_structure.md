# フォルダ構成
※注意
- 以下のフォルダツリーにおいて、`domain/example`、`application/example`はあくまでも例です。
例を参考に、実際に必要なフォルダやファイルを作成してください。

.ci-template/ # CIテンプレート（別プロジェクトへの提供用）フォルダ
  piplines/ # パイプライン定義
    template.yml # テンプレート定義
  variable/ # 変数定義
    variables.yml #　変数の既定値
.gitlab-ci.yml # CI/CDパイプライン（本プロジェクトで利用）定義
dist/ # バンドル後のアプリを保存
src/
  index.ts # AIチェック実行エントリーポイント
  domain/ # ドメイン層
    example/
      index.ts # エントリーポイント
      Example.ts # ユーザエンティティ
      ExampleId.ts # 値オブジェクト
  application/ # アプリケーション層
    shared/ # 全ユースケース共通して利用するフォルダ
      port/
        repository/ # レポジトリIF
    example/
      index.ts # エントリーポイント
      ExampleService.ts # アプリケーションサービス
  mastra/ # mastra関連コード
    index.ts # エントリーポイント（Mastraオブジェクト作成）
    agents/ # エージェント定義
    tools/ # ツール定義
    workflows/ # ワークフロー定義
  infrastructure/ # インフラ層
    adapter/ # アダプタ
      repository/ # リポジトリ実装
  lib/ # 汎用ロジック
