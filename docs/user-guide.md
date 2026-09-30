## お知らせ
 
## 1. AIKATA-PRとは
 AIKATA-PRは、GitLabのマージリクエスト（MR）に対してAIがチェックリストに沿ったレビューを自動実行するCI/CDパイプラインテンプレートです。
 ![image.png](/attachment/69cf920ae4feef880872c39f)

 ### 特徴
 - 定義済みのパイプラインを取り込むだけで簡単に実行
 - チェックリストに定義した観点でMRを自動レビュー
   - チェックリストの内容やdiffの内容によってはAgentがコードベース全体を自律的に調査
 - チェック結果に対する改善提案を受けることが可能
 - 評定基準やコメントフォーマットのカスタマイズが可能

 ### 処理フロー

 ```
 1. MR作成・更新
    ↓
 2. CIパイプラインが起動し、AIKATA-PRが提供するジョブが実行される
    ↓
 3. MRのdiff・最新レビュー結果・メタ情報を取得
    ↓
 4. AIエージェントがレビューを実行
    （コードベース全体の調査が必要な場合はAIエージェントが自律的に調査を実行）
    ↓
 5. 全チェック項目のレビュー完了後、結果をMRにコメント投稿
 ```

 ---

 ## 2. 前提条件
 
特にありません。
 ユーザごとにAIモデルを指定することもできますし、特別に指定しない場合はAIKATA-PR用に用意したAIモデル（AI-bow）が稼働します。（※1）
>※1
 AIモデルを指定した場合は、ジョブが実行されるRunner上で指定されたAIモデルに通信しながらレビューを実行するため、RunnerとAIモデルが疎通できる必要があります。
 指定しない場合はDSSサーバ（DSS GitLabやRedmineが稼働しているサーバ）上に構築したレビュー実行用APIサーバ上でレビューを実行するため、RunnerとDSSサーバが疎通できる必要があります。

 ~~AIKATA-PRを導入するには、AI-bow API等のOpenAI互換のAIモデルを利用者自身で用意する必要があります。
 AIKATA-PRではCI/CDジョブから直接AIモデルを呼びだすので、ジョブが実行されるGitLab RunnerとAIモデルが疎通できる状態である必要があります。
 本番AIbow API（PTU）を利用したい場合はDSS GitLabの[共用Runner](https://references.pages.rp.dss.itmufg/dss/guide/docs/Gitlab_CICD/About-Runner#gitlab-runner%E3%81%…
 ※
 将来的にはAIKATA-PR自体にAIモデルを組み込むことで、AIモデルを用意せずとも利用できる様に計画しています（2026/5月中までには対応予定）
 ゴールデンパスとして組み込む可能性もあります~~

 ---
 ## 3.照会先
 
[照会フォーム](https://apps.powerapps.com/play/e/default-3a498a73-f68c-4993-9940-40f5dc4b029b/a/79c32efa-193c-44f1…
 シンクラにて操作をお願いします
 
---

 ## 4. 導入手順

 ### 4.1 CIテンプレートの設定

 対象プロジェクトの`.gitlab-ci.yml`に以下を追記してください。

 ```yaml
 include:
   - project: systems/bkstm0/aikata-pr
 	file: .ci-template/pipelines/template.yml
 ```
 
※ITCS GitLabの場合は以下のように指定してください
 ```yaml
 include:
   - project: bkstm0/aikata-pr
 	file: .ci-template/pipelines/template.yml
 ```

 これにより、MR作成時に`aikata-pr-review`ジョブが自動実行されます。

> **補足1**: テンプレートにはステージを定義していないため、GitLab CI/CDの仕様により`test`ステージで実行されます。ステージを指定したい場合は適用対象パイプラインにて以下の様にジョブを上書きしてください。
 ```yaml
 include:
   - project: systems/bkstm0/aikata-pr
 	file: .ci-template/pipelines/template.yml

 stages:
   - lint
   - build
   - test
   - deploy

 aikata-pr-review:
   stage: lint
 ```
 
> **補足2**: includeする際にバージョンを指定しないでください。レビュー実行用APIサーバと通信する際にバージョン不整合でエラーになります。

 ### 4.2 CI/CD変数の設定

 GitLabプロジェクトの **Settings > CI/CD > Variables** から以下の変数を設定してください。
 変数設定時はProtect variableにチェックを入れない様に注意してください。
 ![image.png](/attachment/69cf688ee4feef880871c869)
 ![image.png](/attachment/69cf779de4feef8808723452)

 尚、これらの変数は環境変数としてGitLab CI/CDパイプライン実行時に読み込まれます。直接`.gitlab-ci.yml`の`variable`セクションに記載いたいても問題ありません。

 #### 必須変数

 | 変数名 | 説明 | 例 |
 |--------|------|-----|
 | `AIKATA_PR_GITLAB_TOKEN` | GitLab APIトークン（apiスコープ） | `123456789` |
 | `CHECKLIST_PATH` | チェックリストファイルのパス | `.aikata-pr/checklist.csv` |

> **注意**: `AI_API_KEY`と`AIKATA_PR_GITLAB_TOKEN`は秘密情報です。変数設定時に「Mask variable」を有効にしてください。

 #### 任意変数

 | 変数名                	| 説明                                                                                                                                                                                                                                                                 	| デフォルト値   	|
 | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
 | `CHECKLIST_COLUMNS`   	| チェックリストCSVの抽出列番号（カンマ区切り、1始まり）。未指定時は全列を抽出                                                                                                                                                                                         	| なし（全列）   	|
 | `CHECKLIST_NO_HEADER` 	| 抽出列が1列の場合にヘッダ行を除外するか。複数列の場合は無視される                                                                                                                                                                                                    	| `false`        	|
 | `REVIEW_SETTINGS_PATH`	| レビュー設定ファイルのパス                                                                                                                                                                                                                                           	| なし           	|
 | `SKILLS_PATH`         	| Skillsファイル/ディレクトリのパス。レビュー時にAIが適宜指定したSkillsを読み込みながら作業を実行します                                                                                                                                                                	| なし           	|
 | `COMMENT_LANGUAGE`    	| レビューコメントの言語                                                                                                                                                                                                                                               	| `Japanese`     	|
 | `AIKATA_LOG_LEVEL`    	| ログレベル（trace/debug/info/warn/error/fatal）                                                                                                                                                                                                                      	| `info`         	|
 | `AI_API_KEY` | AIモデルのAPIキー（※2） | `123456789` |
 | `AI_API_ENDPOINT_URL` | AIモデルのAPIエンドポイントURL（※2）  | `https://mufg-openai-api.azure-api.net/aoai004/openai/v1` |
 | `AI_MODEL_NAME` | 使用するAIモデル名（※2）  | `PBkBKGPT0SpkSub001OAI001MDL015` |
 | `MAX_CONTEXT_LENGTH`  	| AIモデルの最大コンテキスト長（トークン数）。設定時、プロンプトのトークン数がコンテキスト長の一定割合を超えるとdiffを自動圧縮（AIエージェントは必要な際に自律的に圧縮された部分のdiffを参照）（※2） <br>【参考】aibow gpt-4oの最大コンテキスト長: 128000, aibow gpt-5 〃: 272000 | なし（圧縮しない） |
 | `OPENAI_REASONING_EFFORT` | OpenAI reasoningモデルのreasoning effort（minimal/low/medium/high）。reasoningモデルの場合は設定必須。そうでない場合は必ず設定しない   （※2）                                                                                                                                   	| なし           	|
 | `AIKATA_PR_DISABLED`  	| `true`に設定するとAIレビューをスキップ                                                                                                                                                                                                                               	| `false`        	|

> ※2
 ユーザ独自で利用するAIモデルを変更したい場合は設定してください。`AI_API_KEY`,`AI_API_ENDPOINT_URL`,`AI_MODEL_NAME`がすべて設定されていた場合のみAIモデルが変更されます

 ### 4.3 チェックリストファイルの作成

 チェックリストはCSV形式で作成し、プロジェクトリポジトリ内に配置します。
 CSVの1行目はヘッダ行、2行目以降が各チェック項目に対応します（1行1チェック項目）。

 #### デフォルト動作（複数列・ヘッダあり）

 デフォルトでは、CSVの全列を抽出し、ヘッダ名をキーとした構造化フォーマットでAIに渡されます。

 **入力例: `checklist.csv`**

 ```
 カテゴリ,チェック項目,説明
 セキュリティ,SQLインジェクション対策,バインド変数が使用されているか確認
 パフォーマンス,N+1クエリ,ループ内でのDB問い合わせがないか確認
 ```

 **AIに渡されるフォーマット（1チェック項目あたり）:**

 ```
 カテゴリ:
 ---
 セキュリティ
 ---
 チェック項目:
 ---
 SQLインジェクション対策
 ---
 説明:
 ---
 バインド変数が使用されているか確認
 ---
 ```

 #### オプション: 特定列のみ抽出（`CHECKLIST_COLUMNS`）

 `CHECKLIST_COLUMNS`を指定すると、CSVの特定列のみを抽出できます。列番号は1始まりのカンマ区切りで指定します。

 **例:** 4列のCSVからNo列を除外し、2列目と3列目のみ抽出する場合
 ```
 CHECKLIST_COLUMNS=2,3
 ```
 ```
 No,カテゴリ,チェック項目,説明
 1,セキュリティ,SQLインジェクション対策,バインド変数が使用されているか確認
 ```
 この場合、AIには以下のフォーマットで渡されます:
 ```
 カテゴリ:
 ---
 セキュリティ
 ---
 チェック項目:
 ---
 SQLインジェクション対策
 ---
 ```

 #### オプション: ヘッダ除外（`CHECKLIST_NO_HEADER`）

 抽出結果が1列になる場合に限り、`CHECKLIST_NO_HEADER=true`を指定するとヘッダ行を除外して値のみを抽出できます。これは従来の「1行1チェック項目」形式に相当します。
> **注意**: 抽出結果が複数列の場合、`CHECKLIST_NO_HEADER`は無視されます。
 **例:** 1列のCSVからヘッダを除外する場合
 ```
 CHECKLIST_NO_HEADER=true
 ```
 ```
 チェック項目
 コードの可読性が十分か
 テストが適切に記述されているか
 セキュリティ上の問題がないか
 ```
 この場合、AIには以下のようにヘッダなしの値のみが渡されます:
 ```
 コードの可読性が十分か
 テストが適切に記述されているか
 セキュリティ上の問題がないか
 ```

 #### オプション組み合わせ一覧

 | `CHECKLIST_COLUMNS` | `CHECKLIST_NO_HEADER` | 抽出列数 | AIへの出力形式 |
 |---|---|---|---|
 | 未指定 | `false` | 全列 | ヘッダ付き構造化フォーマット |
 | 未指定 | `true` | 1列のみのCSV | ヘッダなし（値のみ） |
 | 指定（複数列） | `false` | 複数列 | ヘッダ付き構造化フォーマット |
 | 指定（複数列） | `true` | 複数列 | ヘッダ付き構造化フォーマット（`noHeader`は無視） |
 | 指定（1列） | `false` | 1列 | ヘッダ付き構造化フォーマット |
 | 指定（1列） | `true` | 1列 | ヘッダなし（値のみ） |

 **仕様:**
 - CSVの1行目はヘッダ行として扱われる
 - 2行目以降の各行が1つのチェック項目に対応
 - 空行は無視される
 - 最低1つのチェック項目（ヘッダ行 + データ行1行以上）が必要
> **注意**: チェックリストCSVにID列（No列など）を含めないでください。AIKATA-PRはレビュー時に各チェック項目へ独自のIDを自動採番します。CSV側にID列があるとレビュー結果のID管理と競合する可能性があります。既存のCSVにID列が含まれている場合は、`CHECKLIST_COLUMNS`でID列を除外してください。

 ### 4.4 レビュー設定ファイルの作成（任意）

 レビューの動作をカスタマイズする場合、JSON形式のレビュー設定ファイルを作成します。全てのフィールドは任意です。

 **例: `review_settings.json`**

 ```json
 {
   "mrCommentTitle": "AIKATA-PR レビュー結果",
   "additionalInstructions": "必ずdocsディレクトリ内の設計書を読み込み実装方針を理解した上でレビューを実行してください",
   "concurrentReviewCount": null,
   "commentFormat": "【評価理由・根拠】\n（具体的な評価理由や根拠を記載）\n\n【改善提案】\n（具体的な改善提案を記載）",
   "ratings": [
 	{ "label": "A", "definition": "チェック項目の要件を完全に満たしている" },
 	{ "label": "B", "definition": "概ね満たしているが軽微な指摘がある" },
 	{ "label": "C", "definition": "要件を満たしていない" }
   ],
   "hiddenRatingLabels": ["A"],
   "suggestEnabledRatingLabels": ["C"],
   "qualityGate": {
 	"failureCriteria": [
   	{ "ratingLabel": "C", "threshold": 5 }
 	]
   }
 }
 ```

 レビュー設定はJSON形式で記述します。全てのフィールドは任意で、指定しない場合はデフォルト値が適用されます。

 | フィールド           	| 型   	| デフォルト値  | 説明                                                                               	|                                                                                                                                   	|
 | ------------------------ | -------- | ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
 | `mrCommentTitle`     	| string   | `"AIKATA-PR レビュー結果"` | MRコメント先頭の見出しタイトル。空文字は不可                          	|                                                                                                                                   	|
 | `additionalInstructions` | string   | `""`      	| AIレビュー実行時のシステムプロンプトに組み込まれる追加指示                         	|                                                                                                                                   	|
 | `concurrentReviewCount`  | number \ | null      	| `null`                                                                             	| 一度にレビューするチェック項目数（正の整数）。`null`または未指定の場合は分割しない（全項目を一度にレビュー）。1未満の値は`null`に変換 |
 | `commentFormat`      	| string   | `"{comment}"` | レビューコメントのフォーマット                                                     	|                                                                                                                                   	|
 | `ratings`            	| array	| 下記参照  	| 評定基準のリスト                                                                   	|                                                                                                                                   	|
 | `hiddenRatingLabels` 	| string[] | `[]`      	| コメントに表示しない評定のラベルリスト |                                                                                                                                   	|
 | `suggestEnabledRatingLabels` | string[] | `["C"]`   | GitLab MRのsuggest（修正提案）を生成する対象評定ラベル。空配列で無効化。`ratings`に定義済みのラベルのみ指定可能 |                                                                                                        	|
 | `qualityGate` | object | なし | 品質ゲート設定。詳細は[3.5 品質ゲートの設定](#45-品質ゲートの設定任意)を参照 |

 **`concurrentReviewCount`の取り扱い:**
 - チェックリストを分割してレビューするとAI APIを叩く回数が多くなるので、まずは分割しない（`null`）から試してみて、すべてのチェックが完了しない、レビューの精度が悪い等の不具合があれば分割を検討してください。
 **`ratings`のデフォルト値:**

 | ラベル | 定義 |
 |--------|------|
 | A | チェック項目の要件を完全に満たしている |
 | B | 概ね満たしているが軽微な指摘がある |
 | C | 要件を満たしていない |
 | - | チェック項目の要件がdiffの変更内容に該当しない、または評価不能 |

 **`ratings`の制約:**
 - 各要素に`label`（空文字不可）と`definition`（空文字不可）が必要
 - 最低1つの評定基準が必要

 **`hiddenRatingLabels`の制約:**
 - 指定するラベルは`ratings`に定義されているラベルと一致する必要がある

 **`suggestEnabledRatingLabels`の制約:**
 - 指定するラベルは`ratings`に定義されているラベルと一致する必要がある
 - 空配列を指定するとsuggest生成は行われない

 **`suggestEnabledRatingLabels`の挙動:**
 - 対象評定が付いたチェック項目について、AIがGitLab MRの「suggestion」（修正提案）を生成します
 - suggestはMRのdiffハンク内（変更行とその周辺コンテキスト）に限られます。diff範囲外の修正は提案されません
 - diffハンク内で意味のある修正提案が作れない場合、AIはあえてsuggestを生成しません（無理に低品質な提案を作らない）
 - このため、対象評定が付いた全項目に必ずsuggestが生成されるわけではありません
 
![image.png](/attachment/69eabb0de4feef8808a7d127)

 **カスタマイズ例:**

 評定A（問題なし）の結果をコメントに表示せず、指摘があるもののみ表示する場合:

 ```json
 {
   "hiddenRatingLabels": ["A"]
 }
 ```

 独自の評定基準を定義する場合:

 ```json
 {
   "ratings": [
 	{ "label": "OK", "definition": "問題なし" },
 	{ "label": "WARN", "definition": "改善の余地あり" },
 	{ "label": "NG", "definition": "修正が必要" }
   ]
 }
 ```
 ### 4.5 品質ゲートの設定（任意）
 品質ゲートを使用すると、レビュー結果に基づいてパイプラインを失敗させることができます。
 コメントには品質ゲートにより失敗した旨が表示されます。
 ![image.png](/attachment/69cf8ce3e4feef880872a9f8)
 レビュー設定ファイル内の`qualityGate`フィールドで設定します。
 **例: 評定Cが1件以上の場合にパイプラインを失敗させる**
 ```json
 {
   "qualityGate": {
 	"failureCriteria": [
   	{ "ratingLabel": "C", "threshold": 1 }
 	]
   }
 }
 ```
 **例: 複数の基準を設定する（OR条件）**
 ```json
 {
   "qualityGate": {
 	"failureCriteria": [
   	{ "ratingLabel": "C", "threshold": 1 },
   	{ "ratingLabel": "B", "threshold": 5 }
 	]
   }
 }
 ```
 この例では、C評定が1件以上 **または** B評定が5件以上の場合にパイプラインが失敗します。
 | フィールド | 型 | 説明 |
 |-----------|-----|------|
 | `qualityGate` | object | 品質ゲート設定（任意） |
 | `qualityGate.failureCriteria` | array | 失敗基準のリスト |
 | `qualityGate.failureCriteria[].ratingLabel` | string | 評定ラベル（`ratings`に定義されたラベルと一致する必要がある） |
 | `qualityGate.failureCriteria[].threshold` | number | しきい値（1以上の整数。この数以上の該当評定があると失敗） |
 **動作仕様:**
 - 品質ゲートに抵触した場合はジョブは異常終了します。レビュー結果はそのままコメントとして投稿されます
 - コメントに警告メッセージが表示され、どの基準に抵触したかがわかります
 - `hiddenRatingLabels`で非表示にした評定も品質ゲートの評価対象に含まれます
 - 未設定の場合、品質ゲートは適用されません（デフォルト）

 ---

 ## 5. レビュー結果の見方

 ### 5.1 コメント構成と評定ラベル

 AIレビューが完了すると、MRのコメントに以下の形式でコメントが投稿されます。

 - Markdown表形式で各チェック項目の結果（チェック項目名、評定ラベル、コメント）が表示される
 - エラーが発生したチェック項目は、評定欄に「エラー」、コメント欄にエラーメッセージが表示される
 - `hiddenRatingLabels`で指定された評定の結果はコメントの表には表示されない

 ### 5.2 リトライの挙動

 | シナリオ | 挙動 |
 |----------|------|
 | パイプラインをリトライ（コミット変更なし） | 前回成功したレビュー結果はそのまま再利用。エラーだった項目や結果がない項目のみ再レビュー |
 | 新しいコミットをプッシュ | 前回のレビュー結果を参考情報として保持しつつ、全チェック項目を再レビュー |
 | 前回のレビューコメントを削除してからMR更新 | 前回のレビュー結果を参照せず、新規としてレビューを実行 |

 ---

 ## 6. 活用のヒント

 aikata-prはMRの「コード差分」をAIがレビューするツールですが、チェックリストの設計次第で様々な場面に応用できます。

 ### コードレビューの標準化

 チーム共通のコーディング規約やレビュー観点をチェックリストに定義することで、レビューの品質を均一化できます。

 ```csv
 観点,チェック項目
 命名規則,命名規則に従っているか（変数: camelCase、定数: UPPER_SNAKE_CASE）
 責務分離,関数の責務が単一か（1関数1責務）
 エラーハンドリング,適切なエラーハンドリングがされているか
 テスト,テストが追加・更新されているか
 ```

 ### ドキュメントの品質チェック

 ドキュメント（マニュアル、仕様書など）をGit管理し、ドキュメント更新のMRに対してチェックを実行することで、ドキュメントの品質を自動的に担保できます。

 ```csv
 観点,チェック項目
 誤字脱字,誤字脱字がないか
 具体性,説明が十分に具体的で読者が理解できるか
 整合性,記載内容に矛盾がないか
 構成,目次や見出しの構成が適切か
 ```

 ### 設計書とコードの整合性チェック

 設計書をGit管理し、コード修正のMRに対して設計書との整合性をチェックすることで、設計と実装の乖離を早期に検出できます。

 ```csv
 観点,チェック項目
 設計整合,変更内容が設計書（docs/design/配下）の記載と整合しているか
 IF変更,設計書に記載のないインターフェース変更がないか
 設計書更新,設計書の更新が必要な変更の場合設計書も合わせて更新されているか
 ```
 
## 7. FAQ
 
※ITCS GitLabの場合は、本文の導入手順と同様に以下を指定してください。
 
```yaml
 include:
   - project: bkstm0/aikata-pr
 	file: .ci-template/pipelines/template.yml
 ```
 ### Q1
 複数のチェックリストを運用する方法は
 ### A1
 複数のチェックリストを使いたい場合は、レビュー用ジョブを複数定義します。
 
テンプレートには、既定のレビュー用ジョブ `aikata-pr-review` が含まれています。
 1つ目のチェックリストでは、この `aikata-pr-review` の変数を上書きします。
 
2つ目以降のチェックリストでは、`aikata-pr-review` を `extends` して別名のジョブを作成し、
 ジョブごとに `CHECKLIST_PATH` と `REVIEW_SETTINGS_PATH` を指定してください。
 
```yaml
 include:
   - project: systems/bkstm0/aikata-pr
 	file: .ci-template/pipelines/template.yml
 
# テンプレートには、既定のレビュー用ジョブ「aikata-pr-review」が含まれています。
 # ここでは同じ名前のジョブを定義し、1つ目のチェックリスト用に変数だけを上書きします。
 aikata-pr-review:
   variables:
 	# このジョブで使用するチェックリストCSVのパスを指定します。
 	CHECKLIST_PATH: 'path/to/checklist-1.csv'
 
	# このジョブで使用するレビュー設定JSONのパスを指定します。
 	REVIEW_SETTINGS_PATH: 'path/to/review-settings-1.json'
 
# 2つ目以降のチェックリストを実行したい場合は、別名のジョブを追加します。
 # 「extends」を使うことで、aikata-pr-reviewの設定を引き継ぎつつ、
 # CHECKLIST_PATHなど必要な変数だけを変更できます。
 aikata-pr-review-2:
   extends:
 	- aikata-pr-review
   variables:
 	# 2つ目のジョブで使用するチェックリストCSVのパスを指定します。
 	CHECKLIST_PATH: 'path/to/checklist-2.csv'
 
	# 2つ目のジョブで使用するレビュー設定JSONのパスを指定します。
 	REVIEW_SETTINGS_PATH: 'path/to/review-settings-2.json'
 ```
 
---
