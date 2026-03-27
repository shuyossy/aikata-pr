雛形
```
# ID:
- PBI名:
- ステータス: [to do/in progress/done]
- ユーザストーリー/背景
- 受け入れ基準
- 注意事項
- 指摘事項（in progressの場合のみ）
```

# ID: 0
- PBI名: 事前準備
- ステータス: to do
- 背景
  - ID:1以降にスムーズに開発作業に入れる様に、環境を準備しておく必要がある
- 受け入れ基準
  - ロガーが整備できていること
    - MastraのPinoLoggerの再利用可否を調査し、結論をドキュメントに記載していること
    - どのモジュールからでも`getLogger`を呼び出してロガーを取得できること
    - 取得したロガーの出力にユーザIDと時刻が自動付与されていること
    - エラーオブジェクトのログ出力に`pino-std-serializers`の`errWithCause`シリアライザーが利用されていること
    - ロガーのテストが存在し、パスすること
  - `.gitlab-ci.yml`が整備できていること
    - `npm run test`でvitestが実行されるジョブが定義されていること
    - ESLint/Prettierのチェックが実行されるジョブが定義されていること
    - CLI用バンドル（esbuild/tsup等）を実行し`dist/`に出力するジョブが定義されていること
    - バンドルされた成果物がGitLab Package RegistryのGeneric Packagesに公開されるジョブが定義されていること
    - semantic-releaseによるバージョン管理が導入されていること
      - コミットメッセージに基づいてバージョンが自動決定されること
      - GitLabのCI/CDパイプライン上でリリースが自動実行されること
  - formatter/ESLintが整備されていること
    - Prettierの設定ファイルが存在し、`npm run format`で実行できること
    - ESLintの設定ファイルが存在し、`npm run lint`で実行できること
    - husky + lint-stagedが導入され、コミット時にlint/formatが自動実行されること
    - `.gitlab-ci.yml`のジョブでlint/formatチェックが実行されること
  - `.ci-template`が整備されていること
    - `.ci-template/pipelines/template.yml`が存在すること
    - `.ci-template/variable/variables.yml`が存在し、以下の環境変数のデフォルト値が定義されていること
      - AI関連: `AI_API_KEY`、`AI_API_ENDPOINT_URL`
      - GitLab関連: `GITLAB_API_TOKEN`、`GITLAB_PROJECT_ID`、`GITLAB_MR_IID`
      - チェックロジック入力: `CHECKLIST_PATH`、`REVIEW_SETTINGS_PATH`、`SKILLS_PATH`
      - 動作設定: `USER_ID`、`LOG_LEVEL`、`VERBOSE_ERROR`
    - `.env.example`にも同様の環境変数が記載されていること
    - `docs/config/env_val.md`に環境変数の一覧と説明が記載されていること
  - vitestが整備されていること
    - vitestがdevDependenciesに追加されていること
    - vitest設定ファイルが存在し、`npm run test`で実行できること
    - カバレッジ設定が組み込まれ、分岐カバレッジ（branch coverage）の閾値が80%に設定されていること
    - PBI ID:0で実装したモジュール（ロガー等）のテストが存在し、分岐カバレッジ80%以上でパスすること
  - チェックロジックがバンドルでき、CLI上で呼び出せること
    - esbuild/tsup等によるCLI用バンドルスクリプトが存在し、`dist/`に出力されること
    - `node dist/index.js`でバンドル済みファイルが正常に起動すること
    - CLIオプション（`--user-id`）または環境変数（`USER_ID`）でユーザIDを受け取れること
    - 起動時にロガーが動作し、ユーザID付きのログが出力されること
  - 整備の結果として主要コマンドが`AGENTS.md`にまとめられていること
    - PBI ID:0で追加・変更したコマンド（テスト実行、lint、format、バンドル等）が`AGENTS.md`の`# コマンド`セクションに記載されていること
- 注意事項
  - Mastraで定義されているロガーを再利用できないか調べる必要がある
- 指摘事項（in progressの場合のみ）

# ID: 1
- PBI名: システム処理フローの作成
- ステータス: to do
- 背景
  - 処理フロー概念設計にて設計した処理フローを組み立てる
  - mastra workflow内で利用するAgentについては簡易的な実装で良い
    - Agentのブラッシュアップは本PBI以降で実施
- 受け入れ基準
  - 処理フロー概念設計に併せて、処理が実行できる様になっている
    - 想定する処理フローに沿ってmastra workflowが作成されている
      - チェックリスト分割
      - 同時レビュー項目数が2以上かつ総チェック項目数より少ない場合はAIによる分割を実行
      - Agentの処理が失敗した場合は機械的な分割を実行
      - Agentの処理結果が成功した場合もチェックリストが過不足なく分割できているかチェックし、最終的に同時レビュー項目数を満たせる様に機械的に分割（総レビュー項目数が同時レビュー項目数の倍数にならなかった場合は、最後のグループは同時レビュー項目数以下になるのはもちろん許容する）
      - レビュー実行
      - Agentの処理完了時に全てのレビュー対象チェック項目のレビューが完了していない場合は、その旨をAgentに伝えて残りのチェック項目についてのレビューを促す
        - Agentの処理がエラーとなった場合は、その時点で未完了のチェック結果に対し、errorのmessageを格納する
  - 環境変数で指定されたチェックリスト、レビュー設定、skillsのパスがworkflowに連携されている
  - チェックロジック実行時の引数で指定されたユーザIDがRequestContextに格納されており、Agent実行時のRequestContextに含まれている
- 注意事項
- 指摘事項（in progressの場合のみ）

# ID: XX
- PBI名: Agentのブラッシュアップ
- ステータス: to do
- 背景
- 受け入れ基準
- 注意事項
- 指摘事項（in progressの場合のみ）

