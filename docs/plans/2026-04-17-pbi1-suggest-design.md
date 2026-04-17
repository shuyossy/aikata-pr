# PBI1: レビュー結果に基づくコード変更提案（Suggest）機能 設計書

## 概要

レビュー結果の評定に応じて、MR diffの該当箇所に対してGitLabの変更提案（Suggestion）機能を利用した具体的なコード修正案を投稿する。

## 決定事項

1. suggestはレビューエージェント内で同時生成
2. diffフォーマットは現状のunified diff形式のまま
3. 1チェック項目に対して複数suggest可能
4. 古いsuggestのresolve処理はCLI側のCommentPostingServiceで実施
5. 有効なsuggest情報の収集はReviewExecutionService内で実施
6. `suggestEnabledRatingLabels` は ReviewSettings に追加
7. MrDiscussionGatewayにsuggest用の専用メソッドを追加し、既存メソッドの命名も整理
8. storeSuggestツールはコード断片ベース（行番号ではなくoriginalCode/suggestedCode）
9. インフラ層でdiffを解析して行番号を解決（storeSuggestツール内でリアルタイムに実行し、Agentにフィードバック）
10. マッチ曖昧時はthrowせずエージェントにフィードバックして再試行を促す

## GitLab Suggestion API

- 専用APIは不要。Discussion APIに `position` パラメータを付けて、bodyに `` ```suggestion:-X+Y `` 記法のMarkdownを投稿
- `POST /projects/:id/merge_requests/:iid/discussions` に `position` オブジェクト（`position_type`, `base_sha`, `head_sha`, `start_sha`, `old_path`, `new_path`, `new_line`）を含める
- `-X` = アンカー行より上の行数、`+Y` = 下の行数（合計最大201行）
- `diff_refs`（`base_sha`, `head_sha`, `start_sha`）は `GET /projects/:id/merge_requests/:iid` のレスポンスから取得
- discussionのresolve: `PUT /projects/:id/merge_requests/:iid/discussions/:discussion_id` に `{ resolved: true }`

## セクション1: ドメイン層

### 新規: `Suggestion` 値オブジェクト (`src/domain/review/suggestion/`)

```typescript
interface SuggestionParams {
  checkItemContent: string;  // チェック項目の内容（ドメイン識別子）
  filePath: string;
  originalCode: string;      // 置換対象コード（diffの新しい側）
  suggestedCode: string;     // 提案コード
  comment: string;           // suggestに添えるコメント
}

class Suggestion {
  readonly checkItemContent: string;
  readonly filePath: string;
  readonly originalCode: string;
  readonly suggestedCode: string;
  readonly comment: string;

  constructor(params: SuggestionParams) { ... }
}
```

### 新規: `ResolvedSuggestion` 値オブジェクト (`src/domain/review/suggestion/`)

行番号解決後のsuggest情報。GitLab APIへの投稿に必要な位置情報を持つ。

```typescript
interface ResolvedSuggestionParams {
  suggestion: Suggestion;
  newLine: number;         // アンカー行番号 (position[new_line])
  linesAbove: number;      // suggestion:-X
  linesBelow: number;      // suggestion:+Y
  oldPath: string;         // position[old_path]
  newPath: string;         // position[new_path]
}

class ResolvedSuggestion {
  readonly suggestion: Suggestion;
  readonly newLine: number;
  readonly linesAbove: number;
  readonly linesBelow: number;
  readonly oldPath: string;
  readonly newPath: string;

  constructor(params: ResolvedSuggestionParams) { ... }
}
```

### 拡張: `ReviewSettings`

- 追加フィールド: `suggestEnabledRatingLabels: string[]`
- デフォルト: `['C']`
- バリデーション: 指定ラベルが `ratings` に存在すること（`hiddenRatingLabels` と同様）
- 空配列の場合はsuggest無効

### 拡張: `MrContext`

- 追加フィールド: `baseSha: string`, `headSha: string`, `startSha: string`

## セクション2: アプリケーション層

### 2-1. ポート（新規・拡張）

#### 新規: `SuggestionLineResolver` ポート (`src/application/shared/port/suggestion/`)

diffを解析してコード断片から行番号を解決する。storeSuggestツールからリアルタイムに呼び出される。

```typescript
interface LineResolveResult {
  success: boolean;
  newLine?: number;
  linesAbove?: number;
  linesBelow?: number;
  oldPath?: string;
  newPath?: string;
  errorMessage?: string;   // 失敗時: 曖昧性の原因やヒント
}

interface SuggestionLineResolver {
  resolve(
    filePath: string,
    originalCode: string,
    mrDiff: string,
  ): LineResolveResult;
}
```

#### 拡張: `MrDiscussionGateway`

既存メソッドの命名整理 + suggest用メソッド追加。

```typescript
interface MrDiscussionGateway {
  // 既存（命名整理）
  getReviewDiscussions(projectId, mrIid): Promise<MrComment[]>;
  postReviewDiscussion(projectId, mrIid, body): Promise<void>;
  postNote(projectId, mrIid, body): Promise<void>;

  // 新規: suggest用
  getSuggestDiscussions(projectId, mrIid): Promise<SuggestDiscussion[]>;
  postSuggestDiscussion(projectId, mrIid, body, position): Promise<void>;
  resolveDiscussion(projectId, mrIid, discussionId): Promise<void>;
}
```

#### 新規: `SuggestDiscussion` 型

```typescript
interface SuggestDiscussion {
  discussionId: string;          // resolve用
  checkItemContent: string;      // 隠しフィールドから抽出
  filePath: string;
  suggestedCode: string;
  hasChangedSinceNote: boolean;  // system noteに "changed this" 等があるか
}
```

### 2-2. ReviewExecutionService 拡張

```
execute() {
  const suggestDiscussions = await this.mrDiscussionGateway.getSuggestDiscussions(...)

  const currentCheckItemContents = command.checklist.items.map(i => i.content)

  // 有効なsuggest = 以下の全てを満たす
  //   1. hasChangedSinceNote が false（diffが後続コミットで更新されていない）
  //   2. checkItemContent が現在のチェックリストに含まれる
  const activeSuggests = suggestDiscussions.filter(s =>
    !s.hasChangedSinceNote &&
    currentCheckItemContents.includes(s.checkItemContent)
  )

  // resolve対象 = activeでないもの全て
  const suggestsToResolve = suggestDiscussions.filter(s =>
    !activeSuggests.includes(s)
  )

  // ワークフローパラメータに activeSuggests, suggestEnabledRatingLabels を含める
}
```

### 2-3. ReviewExecutionDto 拡張

```typescript
interface ReviewExecutionDto {
  results: ReviewResult[];
  commitHash: string;
  commitMessage: string;
  // 新規
  suggestions: Suggestion[];       // Agentが生成したsuggest一覧（解決済み行番号情報含む）
  baseSha: string;
  headSha: string;
  startSha: string;
}
```

### 2-4. CommentPostingService 拡張

```
execute() {
  // 既存: レビュー結果のコメント投稿

  // 新規: suggest処理
  // 1. 古いsuggestのresolve（suggestsToResolve）
  // 2. 新しいsuggestのdiff discussion投稿（行番号は解決済み）
}
```

### 2-5. CommentPostingCommand 拡張

```typescript
// 追加フィールド
suggestions: ResolvedSuggestion[];              // 解決済みのsuggest一覧
suggestDiscussionsToResolve: SuggestDiscussion[];  // resolve対象の古いsuggest
baseSha: string;
headSha: string;
startSha: string;
```

## セクション3: Mastra層

### 3-1. storeSuggest ツール (`src/mastra/review/tools/storeSuggest.ts`)

```typescript
// input schema
z.object({
  checkItemId: z.number(),       // [ID: N] のID（Mastra層の概念）
  filePath: z.string(),
  originalCode: z.string(),      // 置換対象コード（diff上の新しい側）
  suggestedCode: z.string(),     // 提案コード
  comment: z.string(),
})

// output schema
z.object({
  success: z.boolean(),
  message: z.string().optional(),
})
```

execute内の処理:
1. RequestContextから `checkItems` を取得し、`checkItemId` → `checkItemContent` に変換
2. RequestContextから `activeSuggests` を取得
3. バリデーション:
   - checkItemIdが対象チェック項目に存在するか
   - originalCodeの行数が201行以下か（GitLab上限）
   - 同一filePath + 同一originalCodeの重複チェック（以前の有効suggest + 今回のセッション）
4. **行番号解決（リアルタイム）**: RequestContextから `suggestionLineResolver` と `mrDiff`（圧縮前フルdiff）を取得し、解決を試みる
   - 失敗時: `{ success: false, message: errorMessage }` を返却 → Agentが再試行
   - 成功時: 解決済み情報と共にファイルに保存
5. 結果ファイルに追記（storeReviewResultと同様のファイルロック方式、suggest専用ファイル）

### 3-2. getSuggests ツール (`src/mastra/review/tools/getSuggests.ts`)

```typescript
// input schema: なし
// output schema
z.object({
  suggestions: z.array(z.object({
    checkItemId: z.number(),
    checkItemContent: z.string(),
    filePath: z.string(),
    originalCode: z.string(),
    suggestedCode: z.string(),
    comment: z.string(),
    source: z.enum(['prior', 'current']),
  })),
})
```

- RequestContextから `checkItems` を取得し、自分の担当チェック項目のsuggestのみにフィルタして返却
- `activeSuggests`（prior）もフィルタ済みで含める

### 3-3. reviewAgent 拡張

#### ツールの動的登録

`suggestEnabledRatingLabels` が空でない場合のみ `storeSuggest` / `getSuggests` を登録。既存の画像・diff圧縮ツールとの組み合わせパターンに追加。

#### systemプロンプト

**役割定義（冒頭）の切り替え:**

```
// suggest無効時（現状通り）
You are an expert MR (Merge Request) code review specialist.
You will receive an MR diff, the project folder tree, and a set of check items.
Your job is to evaluate each check item against the MR and provide a rating and comment.

// suggest有効時
You are an expert MR (Merge Request) code review specialist.
You will receive an MR diff, the project folder tree, and a set of check items.
Your job is to evaluate each check item against the MR and provide a rating and comment.
Additionally, for check items rated [suggestEnabledRatingLabels], you MUST generate
concrete code suggestions that directly fix the identified issues.
```

**suggest有効時のみ追加されるセクション:**

```
## Code Suggestion Guidelines

For check items that receive a rating of [suggestEnabledRatingLabels],
you MUST generate concrete code suggestions using the storeSuggest tool.

### How to create suggestions
1. Identify the specific code in the diff that needs improvement
2. Copy the exact original code (as it appears in the new side of the diff)
   into originalCode — include enough surrounding lines to uniquely identify the location
3. Write the improved code in suggestedCode
4. Provide a clear explanation in comment

### Important rules
- You may create multiple suggestions per check item
- Do NOT duplicate suggestions that already exist (check with getSuggests)
- originalCode must exactly match the code in the diff (whitespace-sensitive)
- Include sufficient context lines in originalCode to avoid ambiguity

### Completion requirements (suggestions)
After storing all review results AND all suggestions, call getSuggests to verify completeness.
```

#### userプロンプト

activeSuggestsの具体的な一覧を追加:

```
## Active Suggestions from Prior Reviews

The following suggestions from prior reviews are still active.
Do NOT generate suggestions with the same filePath and originalCode.

[activeSuggestsの一覧]
```

### 3-4. ワークフローパラメータ拡張

`ReviewWorkflowParams` に追加:

```typescript
suggestEnabledRatingLabels: string[];
activeSuggests: Array<{
  checkItemContent: string;
  filePath: string;
  originalCode: string;
  suggestedCode: string;
  comment: string;
}> | null;
suggestResultFilePath: string;
```

`ReviewWorkflowResult` に追加:

```typescript
suggestions: Array<{
  checkItemContent: string;
  filePath: string;
  originalCode: string;
  suggestedCode: string;
  comment: string;
  newLine: number;
  linesAbove: number;
  linesBelow: number;
  oldPath: string;
  newPath: string;
}>;
```

### 3-5. ワークフローステップ内でのactiveSuggests絞り込み

`reviewExecutionStep` で各チェック項目グループにAgentを実行する際:

```typescript
const groupCheckItemContents = group.map(item => item.content)
const groupActiveSuggests = activeSuggests?.filter(s =>
  groupCheckItemContents.includes(s.checkItemContent)
) ?? null
```

## セクション4: インフラ層

### 4-1. `GitLabMrGateway` 拡張

`diff_refs` を `MrContext` に含める:

```typescript
return new MrContext({
  // ...既存フィールド
  baseSha: mrInfo.diff_refs.base_sha,
  headSha: mrInfo.diff_refs.head_sha,
  startSha: mrInfo.diff_refs.start_sha,
});
```

### 4-2. `GitLabMrDiscussionGateway` 拡張

既存メソッドのリネーム + 新規メソッド追加:

```typescript
class GitLabMrDiscussionGateway implements MrDiscussionGateway {
  // リネーム
  async getReviewDiscussions(projectId, mrIid): Promise<MrComment[]> { ... }
  async postReviewDiscussion(projectId, mrIid, body): Promise<void> { ... }
  async postNote(projectId, mrIid, body): Promise<void> { ... }

  // 新規
  async getSuggestDiscussions(projectId, mrIid): Promise<SuggestDiscussion[]> {
    // 1. GET /discussions で全discussion取得
    // 2. 各discussionの最初のnoteに <!-- aikata-suggest --> マーカーがあるか判定
    // 3. マーカーあり:
    //    - 隠しフィールドからcheckItemContent, filePath, suggestedCodeを抽出
    //    - notes内のsystem note（"changed this line"等）を確認 → hasChangedSinceNote
    //    → SuggestDiscussion として返却
  }

  async postSuggestDiscussion(projectId, mrIid, body, position): Promise<void> {
    await this.client.post(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions`,
      {
        body,
        position: {
          position_type: 'text',
          base_sha: position.baseSha,
          head_sha: position.headSha,
          start_sha: position.startSha,
          old_path: position.oldPath,
          new_path: position.newPath,
          new_line: position.newLine,
        },
      },
    );
  }

  async resolveDiscussion(projectId, mrIid, discussionId): Promise<void> {
    await this.client.put(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`,
      { resolved: true },
    );
  }
}
```

`GitLabNote` 型に `system: boolean` フィールドを追加。

### 4-3. system note判定ロジック

```typescript
const CHANGED_KEYWORDS = ['changed this line', 'changed this', 'compare changes'];

function hasChangedSinceNote(notes: GitLabNote[]): boolean {
  return notes.some(
    note => note.system && CHANGED_KEYWORDS.some(kw => note.body.includes(kw))
  );
}
```

### 4-4. `DiffBasedSuggestionLineResolver` 実装 (`src/infrastructure/adapter/review/suggestion/`)

```typescript
class DiffBasedSuggestionLineResolver implements SuggestionLineResolver {
  resolve(filePath, originalCode, mrDiff): LineResolveResult {
    // 1. mrDiffをファイル別に分割
    // 2. filePath に対応するファイルdiffを取得
    //    → 見つからない場合: { success: false, message: "File not found in diff" }
    // 3. ファイルdiffからhunkを解析し、新しい側の行を行番号付きで抽出
    // 4. originalCode の各行を新しい側の行から検索（連続する行のマッチング）
    //    → 0件: { success: false, message: "Code not found in diff..." }
    //    → 2件以上: { success: false, message: "Found N matches. Include more context lines..." }
    //    → 1件: マッチ位置からnewLine, linesAbove, linesBelowを算出
    // 5. oldPath / newPath はdiffヘッダから取得
    // 6. { success: true, newLine, linesAbove, linesBelow, oldPath, newPath }
  }
}
```

### 4-5. suggest discussion body フォーマット

```typescript
class SuggestCommentFormatter {
  static format(resolved: ResolvedSuggestion): string {
    const marker = '<!-- aikata-suggest -->';
    const metadata = `<!-- aikata-suggest-data: ${JSON.stringify({
      checkItemContent: resolved.suggestion.checkItemContent,
      filePath: resolved.suggestion.filePath,
      suggestedCode: resolved.suggestion.suggestedCode,
    })} -->`;

    const header = `**チェック項目:** ${resolved.suggestion.checkItemContent}`;
    const comment = resolved.suggestion.comment;
    const suggestion =
      '```suggestion:-' + resolved.linesAbove + '+' + resolved.linesBelow + '\n' +
      resolved.suggestion.suggestedCode + '\n' +
      '```';

    return [marker, metadata, header, '', comment, '', suggestion].join('\n');
  }
}
```

## セクション5: プレゼンテーション層

### 5-1. ReviewSettings パーサー拡張

review-settings.json に `suggestEnabledRatingLabels` を追加:

```json
{
  "ratings": [...],
  "hiddenRatingLabels": ["-"],
  "suggestEnabledRatingLabels": ["C"]
}
```

- 未指定時のデフォルト: `['C']`
- 空配列 `[]`: suggest無効

### 5-2. ReviewExecutionCommand 拡張

追加フィールド: `suggestEnabledRatingLabels: string[]`

### 5-3. APIモード対応

- APIリクエスト: `suggestEnabledRatingLabels` を含める
- SSEレスポンス: `suggestions` と `baseSha/headSha/startSha` をストリーミング
- CLI側: suggestの投稿とresolveはAPIモードでもCLI側で実行

### 5-4. エラーメッセージ

`suggestEnabledRatingLabels` に存在しないラベルが含まれる場合:

```
Invalid suggestEnabledRatingLabels: label "C" does not exist in ratings.
Available labels: ["S", "A", "B", "D"].
If you have customized ratings, update suggestEnabledRatingLabels to match your rating labels,
or set it to an empty array [] to disable suggestions.
```

## セクション6: エンドツーエンドのデータフロー

```
1. CLI起動
   ├── review-settings.json パース → suggestEnabledRatingLabels 取得
   └── ReviewExecutionCommand 構築

2. ReviewExecutionService.execute()
   ├── mrContext 取得（baseSha/headSha/startSha含む）
   ├── getReviewDiscussions() → 過去レビューコメント取得 → buildPriorContext
   ├── getSuggestDiscussions() → 過去suggestディスカッション取得
   │   ├── activeSuggests = unresolve & チェックリスト内 & diff未更新
   │   └── suggestsToResolve = それ以外
   ├── diff圧縮（必要に応じて）
   └── workflowRunner.run()
       ├── checklistSplitStep（チェック項目分割）
       └── reviewExecutionStep（各グループ並行実行）
           ├── RequestContext設定
           │   ├── mrDiff（圧縮前フルdiff → 行番号解決用）
           │   ├── activeSuggests（グループのチェック項目に絞り込み済み）
           │   └── suggestionLineResolver
           ├── reviewAgent実行
           │   ├── storeReviewResult × N（既存通り）
           │   ├── storeSuggest × M（suggest有効時のみ）
           │   │   ├── バリデーション（重複、行数上限、checkItemId）
           │   │   ├── SuggestionLineResolver で行番号解決
           │   │   │   ├── 成功 → 解決済み情報と共に保存
           │   │   │   └── 失敗 → エラーメッセージ返却 → Agent再試行
           │   │   └── ファイルに保存（排他制御）
           │   └── getSuggests（確認用、担当チェック項目のみ）
           └── 結果収集

3. ReviewExecutionDto 返却
   ├── results: ReviewResult[]
   ├── suggestions: ResolvedSuggestion[]
   └── baseSha, headSha, startSha

4. CommentPostingService.execute()
   ├── 既存: レビュー結果コメント投稿
   ├── 新規: 古いsuggest resolve（resolveDiscussion × N）
   └── 新規: 新しいsuggest投稿（postSuggestDiscussion × M）
       └── SuggestCommentFormatter.format() → body + position
```

APIモードの場合: ステップ2はAPIサーバー側、ステップ3はSSE経由、ステップ4はCLI側。
