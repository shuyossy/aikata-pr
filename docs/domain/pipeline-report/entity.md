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

- パイプライン
  - 識別子: Pipeline
  - 種類: 値オブジェクト
  - 不変条件
    - projectIdが1以上の整数であること
    - pipelineIdが1以上の整数であること
    - refが空文字でないこと
    - shaが空文字でないこと
  - 属性
    - projectId (number)
    - pipelineId (number)
    - ref (string)
    - sha (string)
    - status (string)
    - webUrl (string)
    - createdAt (string, ISO 8601)
    - updatedAt (string, ISO 8601)
  - 振る舞い
    - なし（データホルダ）

- ジョブ
  - 識別子: Job
  - 種類: エンティティ
  - 不変条件
    - idが1以上の整数であること
    - nameが空文字でないこと
    - stageが空文字でないこと
    - statusがJobStatusのリテラルユニオンに含まれること
  - 属性
    - id (number)
    - name (string)
    - stage (string)
    - status (JobStatus)
    - startedAt (string | null, ISO 8601)
    - finishedAt (string | null, ISO 8601)
    - duration (number | null, 秒)
    - webUrl (string)
    - failureReason (string | null)
  - 振る舞い
    - equals(other: Job): id同値比較

- ジョブステータス
  - 識別子: JobStatus
  - 種類: 値オブジェクト（リテラルユニオン）
  - 不変条件
    - `'created' | 'pending' | 'running' | 'failed' | 'success' | 'canceled' | 'skipped' | 'waiting_for_resource' | 'manual' | 'preparing' | 'scheduled'` のいずれかであること
  - 属性
    - リテラル値のみ
  - 振る舞い
    - isTerminated(status): 終了済み判定（success/failed/canceled/skipped を真とする）
    - isSuccessful(status): 成功判定（success のみを真とする）

- ジョブログ
  - 識別子: JobLog
  - 種類: 値オブジェクト
  - 不変条件
    - jobIdが1以上の整数であること
    - fullTextおよびcompressedTextが文字列であること
    - omittedRangeが指定される場合、`{ startCharOffset, endCharOffset, omittedChars }` を持ち、`startCharOffset < endCharOffset` かつ `omittedChars >= 0` であること
  - 属性
    - jobId (number)
    - fullText (string) — 圧縮前の全文
    - compressedText (string) — 圧縮後のテキスト（未圧縮時は fullText と一致）
    - omittedRange (OmittedRange | null) — 省略された中央領域の範囲情報
    - totalChars (number) — fullText の文字数
  - 振る舞い
    - full(params): 圧縮されていないファクトリ
    - compressed(params): 中央省略済みのファクトリ
    - isCompressed(): 省略範囲の有無を返す
  - 関連型
    - OmittedRange: `{ startCharOffset: number, endCharOffset: number, omittedChars: number }`

- アーティファクトエントリ
  - 識別子: ArtifactEntry
  - 種類: 値オブジェクト
  - 不変条件
    - pathが空文字でないこと
    - typeが `'file' | 'dir'` のいずれかであること
    - sizeが 0 以上であること
  - 属性
    - path (string) — zip 内の相対パス
    - type ('file' | 'dir')
    - size (number, bytes)
    - mode (number | null)
  - 振る舞い
    - なし

- アーティファクトツリー
  - 識別子: ArtifactTree
  - 種類: 値オブジェクト（集約）
  - 不変条件
    - jobIdが1以上の整数であること
    - entriesが配列であること（空配列は許容）
  - 属性
    - jobId (number)
    - entries (ArtifactEntry[])
  - 振る舞い
    - isEmpty(): entriesが空か判定

- パイプラインレポート設定
  - 識別子: PipelineReportSettings
  - 種類: 値オブジェクト
  - 不変条件
    - jobReportFormatが空文字でないこと
    - includeJobPatterns/excludeJobPatterns が `RegExp[]` であること
  - 属性
    - jobReportFormat (string)
    - additionalInstructions (string | null)
    - includeJobPatterns (readonly RegExp[])
    - excludeJobPatterns (readonly RegExp[])
  - 振る舞い
    - default(静的ファクトリ): デフォルト設定（デフォルト jobReportFormat / additionalInstructions=null / include/exclude空）を生成
    - of(params)(静的ファクトリ): 任意の値から生成
    - filterJobs(jobs, selfJobId): 分析対象ジョブ選定ビジネスルール
      1. selfJobId と一致するジョブを除外
      2. includeJobPatterns が非空の場合、いずれかにマッチするジョブのみ通過
      3. excludeJobPatterns のいずれかにマッチするジョブを除外

- 分析レポート
  - 識別子: AnalysisReport
  - 種類: 値オブジェクト
  - 不変条件
    - contentが文字列であること
  - 属性
    - content (string)
  - 振る舞い
    - of(content)(静的ファクトリ): 内容から生成
    - isEmpty(): contentが空または空白のみか判定
