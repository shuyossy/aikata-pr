# エンティティ
記載フォーマット
```
- エンティティ名
  - 識別子: [英語で記載、実装するクラス名と同じにする]
  - 種類: [エンティティ/値オブジェクト/集約ルート]
  - 不変条件
    - [不変条件(常に守られるべき状態ルール)を箇条書き]
  - 属性
    - [箇条書き]
  - 振る舞い
    - [箇条書き]
```

---

- チェック項目
  - 識別子: CheckItem
  - 種類: エンティティ
  - 不変条件
    - contentが空文字でないこと
  - 属性
    - content (string)
  - 振る舞い
    - equals(other: CheckItem): 同値比較

- 評定
  - 識別子: Rating
  - 種類: 値オブジェクト
  - 不変条件
    - labelが空文字でないこと
    - definitionが空文字でないこと
  - 属性
    - label (string)
    - definition (string)
  - 振る舞い
    - equals(other: Rating): 同値比較

- レビュー結果
  - 識別子: ReviewResult
  - 種類: エンティティ
  - 不変条件
    - なし（ファクトリメソッドで生成）
  - 属性
    - checkItem (CheckItem)
    - comment (string)
    - rating (Rating)
    - isError (boolean)
    - errorMessage (string, optional)
  - 振る舞い
    - success(静的ファクトリ): 成功結果を生成
    - error(静的ファクトリ): エラー結果を生成

- 品質ゲート
  - 識別子: QualityGate
  - 種類: 値オブジェクト
  - 不変条件
    - failureCriteriaの各要素のratingLabelが空文字でないこと
    - failureCriteriaの各要素のthresholdが1以上であること
  - 属性
    - failureCriteria (FailureCriterion[])
      - FailureCriterion: { ratingLabel: string, threshold: number }
  - 振る舞い
    - evaluate(results: ReviewResult[]): QualityGateResult - 品質ゲートの評価
    - none(静的ファクトリ): 基準なしの品質ゲートを生成
  - 関連型
    - QualityGateResult: { passed: boolean, violations: QualityGateViolation[] }
    - QualityGateViolation: { ratingLabel: string, threshold: number, actualCount: number }

- レビュー設定
  - 識別子: ReviewSettings
  - 種類: 値オブジェクト
  - 不変条件
    - concurrentReviewCountがnullまたは1以上
    - ratingsが空でないこと
    - hiddenRatingLabelsの各ラベルがratingsに存在すること
    - qualityGateのfailureCriteriaの各ratingLabelがratingsに存在すること
  - 属性
    - additionalInstructions (string)
    - concurrentReviewCount (number | null)
    - commentFormat (string)
    - ratings (Rating[])
    - hiddenRatingLabels (string[])
    - qualityGate (QualityGate)
  - 振る舞い
    - default(静的ファクトリ): デフォルト設定を生成

- チェックリスト
  - 識別子: Checklist
  - 種類: エンティティ
  - 不変条件
    - itemsが空でないこと
  - 属性
    - items (CheckItem[])
    - size (number, getter)
  - 振る舞い
    - splitByCount(count: number): 機械的分割

- MRコンテキスト
  - 識別子: MrContext
  - 種類: 値オブジェクト
  - 不変条件
    - なし
  - 属性
    - title (string)
    - description (string)
    - sourceBranch (string)
    - targetBranch (string)
    - diff (string)
    - commitHash (string)
  - 振る舞い
    - なし

