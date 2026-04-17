# Suggest機能 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** レビュー結果の評定に応じて、GitLabの変更提案（Suggestion）機能を利用した具体的なコード修正案をMR diff上に投稿する

**Architecture:** 既存のreview機能をレイヤーごとに拡張。ドメイン層にSuggestion/ResolvedSuggestion値オブジェクト追加、アプリケーション層にSuggestionLineResolverポートとMrDiscussionGateway拡張、Mastra層にstoreSuggest/getSuggestsツール追加とreviewAgentプロンプト拡張、インフラ層にDiffBasedSuggestionLineResolver実装とGitLabMrDiscussionGateway拡張

**Tech Stack:** TypeScript, Mastra, Zod, GitLab API v4 (v16), Vitest

**設計書:** `docs/plans/2026-04-17-pbi1-suggest-design.md`

---

### Task 1: ドメイン層 — Suggestion値オブジェクト

**Files:**
- Create: `src/domain/review/suggestion/Suggestion.ts`
- Create: `src/domain/review/suggestion/ResolvedSuggestion.ts`
- Create: `src/domain/review/suggestion/index.ts`
- Create: `src/domain/review/suggestion/__tests__/Suggestion.test.ts`
- Create: `src/domain/review/suggestion/__tests__/ResolvedSuggestion.test.ts`

**Step 1: Suggestionのテストを書く**

```typescript
// src/domain/review/suggestion/__tests__/Suggestion.test.ts
import { describe, it, expect } from 'vitest';
import { Suggestion } from '../Suggestion.js';

describe('Suggestion', () => {
  const validParams = {
    checkItemContent: 'エラーハンドリングが適切であること',
    filePath: 'src/index.ts',
    originalCode: 'console.log(error);',
    suggestedCode: 'logger.error(error);',
    comment: 'Use logger instead of console.log',
  };

  it('should create a Suggestion with valid params', () => {
    const suggestion = new Suggestion(validParams);
    expect(suggestion.checkItemContent).toBe(validParams.checkItemContent);
    expect(suggestion.filePath).toBe(validParams.filePath);
    expect(suggestion.originalCode).toBe(validParams.originalCode);
    expect(suggestion.suggestedCode).toBe(validParams.suggestedCode);
    expect(suggestion.comment).toBe(validParams.comment);
  });

  it('should throw if checkItemContent is empty', () => {
    expect(() => new Suggestion({ ...validParams, checkItemContent: '' })).toThrow();
  });

  it('should throw if filePath is empty', () => {
    expect(() => new Suggestion({ ...validParams, filePath: '' })).toThrow();
  });

  it('should throw if originalCode is empty', () => {
    expect(() => new Suggestion({ ...validParams, originalCode: '' })).toThrow();
  });

  it('should throw if suggestedCode is empty', () => {
    expect(() => new Suggestion({ ...validParams, suggestedCode: '' })).toThrow();
  });

  it('should throw if comment is empty', () => {
    expect(() => new Suggestion({ ...validParams, comment: '' })).toThrow();
  });
});
```

**Step 2: テストが失敗することを確認**

Run: `npx vitest run src/domain/review/suggestion/__tests__/Suggestion.test.ts`
Expected: FAIL (module not found)

**Step 3: Suggestion値オブジェクトを実装**

```typescript
// src/domain/review/suggestion/Suggestion.ts
interface SuggestionParams {
  checkItemContent: string;
  filePath: string;
  originalCode: string;
  suggestedCode: string;
  comment: string;
}

export class Suggestion {
  readonly checkItemContent: string;
  readonly filePath: string;
  readonly originalCode: string;
  readonly suggestedCode: string;
  readonly comment: string;

  constructor(params: SuggestionParams) {
    if (!params.checkItemContent) throw new Error('checkItemContent must not be empty');
    if (!params.filePath) throw new Error('filePath must not be empty');
    if (!params.originalCode) throw new Error('originalCode must not be empty');
    if (!params.suggestedCode) throw new Error('suggestedCode must not be empty');
    if (!params.comment) throw new Error('comment must not be empty');
    this.checkItemContent = params.checkItemContent;
    this.filePath = params.filePath;
    this.originalCode = params.originalCode;
    this.suggestedCode = params.suggestedCode;
    this.comment = params.comment;
  }
}
```

**Step 4: テストがパスすることを確認**

Run: `npx vitest run src/domain/review/suggestion/__tests__/Suggestion.test.ts`
Expected: PASS

**Step 5: ResolvedSuggestionのテストを書く**

```typescript
// src/domain/review/suggestion/__tests__/ResolvedSuggestion.test.ts
import { describe, it, expect } from 'vitest';
import { Suggestion } from '../Suggestion.js';
import { ResolvedSuggestion } from '../ResolvedSuggestion.js';

describe('ResolvedSuggestion', () => {
  const suggestion = new Suggestion({
    checkItemContent: 'check',
    filePath: 'src/index.ts',
    originalCode: 'old',
    suggestedCode: 'new',
    comment: 'fix',
  });

  const validParams = {
    suggestion,
    newLine: 42,
    linesAbove: 2,
    linesBelow: 3,
    oldPath: 'src/index.ts',
    newPath: 'src/index.ts',
  };

  it('should create a ResolvedSuggestion with valid params', () => {
    const resolved = new ResolvedSuggestion(validParams);
    expect(resolved.suggestion).toBe(suggestion);
    expect(resolved.newLine).toBe(42);
    expect(resolved.linesAbove).toBe(2);
    expect(resolved.linesBelow).toBe(3);
    expect(resolved.oldPath).toBe('src/index.ts');
    expect(resolved.newPath).toBe('src/index.ts');
  });

  it('should throw if newLine is less than 1', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, newLine: 0 })).toThrow();
  });

  it('should throw if linesAbove is negative', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, linesAbove: -1 })).toThrow();
  });

  it('should throw if linesBelow is negative', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, linesBelow: -1 })).toThrow();
  });

  it('should throw if total lines exceed 201', () => {
    expect(() => new ResolvedSuggestion({ ...validParams, linesAbove: 100, linesBelow: 101 })).toThrow();
  });

  it('should allow total of exactly 201 lines', () => {
    const resolved = new ResolvedSuggestion({ ...validParams, linesAbove: 100, linesBelow: 100 });
    expect(resolved.linesAbove).toBe(100);
    expect(resolved.linesBelow).toBe(100);
  });
});
```

**Step 6: ResolvedSuggestionを実装**

```typescript
// src/domain/review/suggestion/ResolvedSuggestion.ts
import type { Suggestion } from './Suggestion.js';

interface ResolvedSuggestionParams {
  suggestion: Suggestion;
  newLine: number;
  linesAbove: number;
  linesBelow: number;
  oldPath: string;
  newPath: string;
}

export class ResolvedSuggestion {
  readonly suggestion: Suggestion;
  readonly newLine: number;
  readonly linesAbove: number;
  readonly linesBelow: number;
  readonly oldPath: string;
  readonly newPath: string;

  constructor(params: ResolvedSuggestionParams) {
    if (params.newLine < 1) throw new Error('newLine must be at least 1');
    if (params.linesAbove < 0) throw new Error('linesAbove must not be negative');
    if (params.linesBelow < 0) throw new Error('linesBelow must not be negative');
    if (params.linesAbove + params.linesBelow + 1 > 201) {
      throw new Error('Total suggestion range must not exceed 201 lines');
    }
    this.suggestion = params.suggestion;
    this.newLine = params.newLine;
    this.linesAbove = params.linesAbove;
    this.linesBelow = params.linesBelow;
    this.oldPath = params.oldPath;
    this.newPath = params.newPath;
  }
}
```

**Step 7: バレルexportを作成しテスト実行**

```typescript
// src/domain/review/suggestion/index.ts
export { Suggestion } from './Suggestion.js';
export { ResolvedSuggestion } from './ResolvedSuggestion.js';
```

Run: `npx vitest run src/domain/review/suggestion/`
Expected: PASS (全テスト)

**Step 8: コミット**

```bash
git add src/domain/review/suggestion/
git commit -m "feat: add Suggestion and ResolvedSuggestion value objects"
```

---

### Task 2: ドメイン層 — ReviewSettings拡張 + MrContext拡張

**Files:**
- Modify: `src/domain/review/reviewSettings/ReviewSettings.ts`
- Modify: `src/domain/review/reviewSettings/__tests__/ReviewSettings.test.ts`
- Modify: `src/domain/review/mrContext/MrContext.ts`
- Modify: `src/domain/review/mrContext/__tests__/MrContext.test.ts` (存在する場合)

**Step 1: ReviewSettingsのテストを追加**

`src/domain/review/reviewSettings/__tests__/ReviewSettings.test.ts` に以下のテストを追加:

```typescript
describe('suggestEnabledRatingLabels', () => {
  it('should default to ["C"] when using default()', () => {
    const settings = ReviewSettings.default();
    expect(settings.suggestEnabledRatingLabels).toEqual(['C']);
  });

  it('should accept valid suggestEnabledRatingLabels', () => {
    const settings = new ReviewSettings({
      ...defaultParams,
      suggestEnabledRatingLabels: ['B', 'C'],
    });
    expect(settings.suggestEnabledRatingLabels).toEqual(['B', 'C']);
  });

  it('should accept empty array (suggest disabled)', () => {
    const settings = new ReviewSettings({
      ...defaultParams,
      suggestEnabledRatingLabels: [],
    });
    expect(settings.suggestEnabledRatingLabels).toEqual([]);
  });

  it('should throw if suggestEnabledRatingLabels contains unknown label', () => {
    expect(() => new ReviewSettings({
      ...defaultParams,
      suggestEnabledRatingLabels: ['X'],
    })).toThrow('suggestEnabledRatingLabels contains unknown label: X');
  });
});
```

**Step 2: テストが失敗することを確認**

Run: `npx vitest run src/domain/review/reviewSettings/__tests__/ReviewSettings.test.ts`
Expected: FAIL

**Step 3: ReviewSettingsを拡張**

`src/domain/review/reviewSettings/ReviewSettings.ts` を修正:
- `ReviewSettingsParams` に `suggestEnabledRatingLabels: string[]` を追加
- コンストラクタにバリデーション追加（`hiddenRatingLabels` と同じパターン）
- `default()` のデフォルト値: `['C']`

**Step 4: 既存テストを含め全テストがパスすることを確認**

Run: `npx vitest run src/domain/review/reviewSettings/`
Expected: PASS

**Step 5: MrContextを拡張**

`src/domain/review/mrContext/MrContext.ts` の `MrContextParams` と `MrContext` に `baseSha`, `headSha`, `startSha` を追加。既存テストがあれば更新。

**Step 6: テスト実行**

Run: `npx vitest run src/domain/review/mrContext/`
Expected: PASS

**Step 7: コミット**

```bash
git add src/domain/review/reviewSettings/ src/domain/review/mrContext/
git commit -m "feat: add suggestEnabledRatingLabels to ReviewSettings and diff_refs to MrContext"
```

---

### Task 3: アプリケーション層 — SuggestionLineResolverポート + SuggestDiscussion型

**Files:**
- Create: `src/application/shared/port/suggestion/SuggestionLineResolver.ts`
- Create: `src/application/shared/port/suggestion/index.ts`
- Create: `src/application/shared/port/gateway/SuggestDiscussion.ts`
- Modify: `src/application/shared/port/gateway/index.ts`

**Step 1: SuggestionLineResolverポートを作成**

```typescript
// src/application/shared/port/suggestion/SuggestionLineResolver.ts
export interface LineResolveResult {
  success: boolean;
  newLine?: number;
  linesAbove?: number;
  linesBelow?: number;
  oldPath?: string;
  newPath?: string;
  errorMessage?: string;
}

export interface SuggestionLineResolver {
  resolve(
    filePath: string,
    originalCode: string,
    mrDiff: string,
  ): LineResolveResult;
}
```

```typescript
// src/application/shared/port/suggestion/index.ts
export type { SuggestionLineResolver, LineResolveResult } from './SuggestionLineResolver.js';
```

**Step 2: SuggestDiscussion型を作成**

```typescript
// src/application/shared/port/gateway/SuggestDiscussion.ts
export interface SuggestDiscussion {
  discussionId: string;
  checkItemContent: string;
  filePath: string;
  suggestedCode: string;
  hasChangedSinceNote: boolean;
}
```

**Step 3: ゲートウェイのバレルexportを更新**

`src/application/shared/port/gateway/index.ts` に `SuggestDiscussion` のexportを追加。

**Step 4: コミット**

```bash
git add src/application/shared/port/suggestion/ src/application/shared/port/gateway/
git commit -m "feat: add SuggestionLineResolver port and SuggestDiscussion type"
```

---

### Task 4: アプリケーション層 — MrDiscussionGatewayリネーム + 拡張

**Files:**
- Modify: `src/application/shared/port/gateway/MrDiscussionGateway.ts`
- Modify: `src/infrastructure/adapter/review/gateway/GitLabMrDiscussionGateway.ts`
- Modify: `src/infrastructure/adapter/review/gateway/__tests__/GitLabMrDiscussionGateway.test.ts`
- Modify: `src/application/review/reviewExecution/ReviewExecutionService.ts`
- Modify: `src/application/review/reviewExecution/__tests__/ReviewExecutionService.test.ts`
- Modify: `src/application/review/commentPosting/CommentPostingService.ts`
- Modify: `src/application/review/commentPosting/__tests__/CommentPostingService.test.ts`
- Modify: その他参照箇所（`src/presentation/api/review/reviewHandler.ts`, `src/cli/review/index.ts` 等）

**Step 1: MrDiscussionGatewayインターフェースをリネーム + 拡張**

`src/application/shared/port/gateway/MrDiscussionGateway.ts`:
- `getDiscussions` → `getReviewDiscussions`
- `postDiscussion` → `postReviewDiscussion`
- `postNote` はそのまま
- 新規メソッド追加: `getSuggestDiscussions`, `postSuggestDiscussion`, `resolveDiscussion`

`postSuggestDiscussion` の `position` パラメータ用の型も定義:

```typescript
export interface DiffPosition {
  baseSha: string;
  headSha: string;
  startSha: string;
  oldPath: string;
  newPath: string;
  newLine: number;
}
```

**Step 2: 全参照箇所を一括リネーム**

`getDiscussions` → `getReviewDiscussions`, `postDiscussion` → `postReviewDiscussion` を以下のファイルで更新:
- `GitLabMrDiscussionGateway.ts` (実装)
- `ReviewExecutionService.ts` (呼び出し)
- `CommentPostingService.ts` (呼び出し)
- `reviewHandler.ts` (インスタンス化)
- `src/cli/review/index.ts` (インスタンス化)
- 全テストファイル (モック定義・アサーション)

**Step 3: GitLabMrDiscussionGatewayに新規メソッドのスタブ実装を追加**

`getSuggestDiscussions`, `postSuggestDiscussion`, `resolveDiscussion` のスタブ（中身は後のTaskで実装）。

**Step 4: 全テスト実行**

Run: `npx vitest run`
Expected: PASS (リネームが全箇所で正しく適用されていること)

**Step 5: コミット**

```bash
git add -A
git commit -m "refactor: rename getDiscussions/postDiscussion to getReviewDiscussions/postReviewDiscussion and add suggest methods to MrDiscussionGateway"
```

---

### Task 5: インフラ層 — DiffBasedSuggestionLineResolver

**Files:**
- Create: `src/infrastructure/adapter/review/suggestion/DiffBasedSuggestionLineResolver.ts`
- Create: `src/infrastructure/adapter/review/suggestion/__tests__/DiffBasedSuggestionLineResolver.test.ts`
- Create: `src/infrastructure/adapter/review/suggestion/index.ts`

**Step 1: テストを書く**

`src/infrastructure/adapter/review/suggestion/__tests__/DiffBasedSuggestionLineResolver.test.ts`:

テストケース:
- 単一hunkで1行マッチ → 正しいnewLine, linesAbove=0, linesBelow=0
- 複数行マッチ（連続行） → 正しいnewLine, linesAbove, linesBelow算出
- ファイルが見つからない → `{ success: false, message: "File not found..." }`
- コードが見つからない → `{ success: false, message: "Code not found..." }`
- 複数箇所にマッチ → `{ success: false, message: "Found N matches..." }`
- 複数hunkにまたがるdiffでの正確なマッチ
- コンテキスト行（変更なし行）へのマッチ
- 追加行（+行）へのマッチ
- ファイルリネームのケース（old_path != new_path）

テストで使用するdiffは実際のunified diff形式で作成。

**Step 2: テストが失敗することを確認**

Run: `npx vitest run src/infrastructure/adapter/review/suggestion/`
Expected: FAIL

**Step 3: DiffBasedSuggestionLineResolverを実装**

```typescript
// src/infrastructure/adapter/review/suggestion/DiffBasedSuggestionLineResolver.ts
import type { SuggestionLineResolver, LineResolveResult } from '../../../../application/shared/port/suggestion/index.js';
import { splitDiffByFile } from '../../../../application/shared/diffCompression/DiffCompressor.js';

export class DiffBasedSuggestionLineResolver implements SuggestionLineResolver {
  resolve(filePath: string, originalCode: string, mrDiff: string): LineResolveResult {
    // 1. mrDiffをファイル別に分割（既存のsplitDiffByFileを再利用）
    // 2. filePathに対応するdiffを取得（完全一致 → 部分一致フォールバック）
    // 3. diffヘッダからold_path, new_pathを抽出
    // 4. hunkを解析: @@ -oldStart,oldCount +newStart,newCount @@ パターン
    // 5. 新しい側の行を行番号付きで抽出（+行とコンテキスト行）
    // 6. originalCodeの行を連続マッチングで検索
    //    - マッチ数0: エラーメッセージ
    //    - マッチ数2+: エラーメッセージ
    //    - マッチ数1: newLine（先頭行）, linesAbove=0, linesBelow=matchedLines-1 を算出
    // 7. 成功結果を返却
  }
}
```

アルゴリズム詳細:
- hunk解析: `@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@` でhunkヘッダをパース
- 行追跡: hunk内の各行について `+` → 新しい側の行（newLineNum++）, `-` → 古い側の行（oldLineNum++）, ` ` → 両方
- マッチング: originalCodeを行分割し、新しい側の行リスト内で連続する部分文字列として検索
- newLine算出: マッチの最初の行のnewLineNum
- linesAbove/linesBelow: GitLabの `suggestion:-X+Y` はアンカー行からの相対位置。アンカー行 = マッチの最初の行とし、linesAbove=0, linesBelow=matchedLines-1

**Step 4: テストがパスすることを確認**

Run: `npx vitest run src/infrastructure/adapter/review/suggestion/`
Expected: PASS

**Step 5: バレルexportを作成**

```typescript
// src/infrastructure/adapter/review/suggestion/index.ts
export { DiffBasedSuggestionLineResolver } from './DiffBasedSuggestionLineResolver.js';
```

**Step 6: コミット**

```bash
git add src/infrastructure/adapter/review/suggestion/
git commit -m "feat: implement DiffBasedSuggestionLineResolver for code-to-line-number resolution"
```

---

### Task 6: インフラ層 — GitLabMrGateway拡張（diff_refs）

**Files:**
- Modify: `src/infrastructure/adapter/gateway/GitLabMrGateway.ts`
- Modify: `src/infrastructure/adapter/gateway/__tests__/GitLabMrGateway.test.ts`

**Step 1: テストを更新**

`GitLabMrGateway.test.ts` で `getMrContext` のテストに `baseSha`, `headSha`, `startSha` のアサーションを追加。モックの `GitLabMrInfo` レスポンスに `diff_refs` を含める。

**Step 2: テストが失敗することを確認**

Run: `npx vitest run src/infrastructure/adapter/gateway/__tests__/GitLabMrGateway.test.ts`
Expected: FAIL (baseSha等がundefined)

**Step 3: GitLabMrGatewayを修正**

`getMrContext` 内の `new MrContext()` に `baseSha`, `headSha`, `startSha` を追加:

```typescript
return new MrContext({
  // ...既存フィールド
  baseSha: mrInfo.diff_refs.base_sha,
  headSha: mrInfo.diff_refs.head_sha,
  startSha: mrInfo.diff_refs.start_sha,
});
```

**Step 4: テストがパスすることを確認**

Run: `npx vitest run src/infrastructure/adapter/gateway/__tests__/GitLabMrGateway.test.ts`
Expected: PASS

**Step 5: コミット**

```bash
git add src/infrastructure/adapter/gateway/ src/domain/review/mrContext/
git commit -m "feat: expose diff_refs (baseSha/headSha/startSha) from GitLabMrGateway to MrContext"
```

---

### Task 7: インフラ層 — GitLabMrDiscussionGateway拡張（suggest用メソッド実装）

**Files:**
- Modify: `src/infrastructure/adapter/review/gateway/GitLabMrDiscussionGateway.ts`
- Modify: `src/infrastructure/adapter/review/gateway/__tests__/GitLabMrDiscussionGateway.test.ts`

**Step 1: テストを追加**

`GitLabMrDiscussionGateway.test.ts` に以下のdescribeブロックを追加:
- `getSuggestDiscussions`: マーカー検出、隠しフィールドパース、system note判定、マーカーなしdiscussionの除外
- `postSuggestDiscussion`: positionパラメータ付きでAPIが呼ばれること
- `resolveDiscussion`: PUT APIが正しいエンドポイントで呼ばれること

**Step 2: テストが失敗することを確認**

Run: `npx vitest run src/infrastructure/adapter/review/gateway/__tests__/GitLabMrDiscussionGateway.test.ts`
Expected: FAIL

**Step 3: GitLabMrDiscussionGatewayのメソッドを実装**

`GitLabNote` 型に `system: boolean` を追加。

`getSuggestDiscussions`: 
- `getAll` で全discussion取得
- 各discussionの最初のnoteに `<!-- aikata-suggest -->` マーカーがあるか判定
- `<!-- aikata-suggest-data: {...} -->` から JSON をパース
- notes内に `system: true` かつ `CHANGED_KEYWORDS` を含むnoteがあるか判定

`postSuggestDiscussion`:
- `client.post` に `body` + `position` パラメータ付きでPOST

`resolveDiscussion`:
- `client.put` で discussion を resolve

**Step 4: テストがパスすることを確認**

Run: `npx vitest run src/infrastructure/adapter/review/gateway/__tests__/GitLabMrDiscussionGateway.test.ts`
Expected: PASS

**Step 5: コミット**

```bash
git add src/infrastructure/adapter/review/gateway/
git commit -m "feat: implement getSuggestDiscussions, postSuggestDiscussion, resolveDiscussion in GitLabMrDiscussionGateway"
```

---

### Task 8: インフラ層 — SuggestCommentFormatter

**Files:**
- Create: `src/application/shared/comment/SuggestCommentFormatter.ts`
- Create: `src/application/shared/comment/__tests__/SuggestCommentFormatter.test.ts`
- Modify: `src/application/shared/comment/index.ts`

**Step 1: テストを書く**

```typescript
// テストケース:
// - マーカー（<!-- aikata-suggest -->）が含まれること
// - メタデータJSON（<!-- aikata-suggest-data: {...} -->）が含まれること
// - チェック項目ヘッダが含まれること
// - コメントが含まれること
// - suggestion記法（```suggestion:-X+Y）が正しいフォーマットであること
// - linesAbove=0, linesBelow=0 のケース（単一行suggest）
// - linesAbove=5, linesBelow=3 のケース（複数行suggest）
```

**Step 2: テストが失敗することを確認**

**Step 3: SuggestCommentFormatterを実装**

`ResolvedSuggestion` を受け取り、GitLab suggest形式のMarkdown bodyを生成する静的メソッド `format()` を実装。

**Step 4: テストがパスすることを確認**

**Step 5: SuggestCommentParserを実装**

suggest discussionのbodyからメタデータを抽出する静的メソッド `parse()` を実装（`getSuggestDiscussions` で使用）。

**Step 6: バレルexportを更新**

**Step 7: コミット**

```bash
git add src/application/shared/comment/
git commit -m "feat: add SuggestCommentFormatter and SuggestCommentParser"
```

---

### Task 9: アプリケーション層 — ReviewSettingsParser拡張

**Files:**
- Modify: `src/application/shared/parser/ReviewSettingsParser.ts`
- Modify: `src/application/shared/parser/__tests__/ReviewSettingsParser.test.ts`

**Step 1: テストを追加**

```typescript
// テストケース:
// - suggestEnabledRatingLabels未指定 → デフォルト['C']
// - suggestEnabledRatingLabels指定 → そのまま使用
// - suggestEnabledRatingLabels空配列 → suggest無効
// - suggestEnabledRatingLabelsに不正なラベル → ReviewSettingsのバリデーションエラー（エラーメッセージにカスタムラベルの案内を含む）
```

**Step 2: テストが失敗することを確認**

**Step 3: ReviewSettingsParserを修正**

Zodスキーマに `suggestEnabledRatingLabels: z.array(z.string().min(1)).optional()` を追加。`ReviewSettings` コンストラクタに渡す。

**Step 4: テストがパスすることを確認**

Run: `npx vitest run src/application/shared/parser/`
Expected: PASS

**Step 5: コミット**

```bash
git add src/application/shared/parser/
git commit -m "feat: add suggestEnabledRatingLabels to ReviewSettingsParser"
```

---

### Task 10: アプリケーション層 — ReviewExecutionService拡張

**Files:**
- Modify: `src/application/review/reviewExecution/ReviewExecutionService.ts`
- Modify: `src/application/review/reviewExecution/ReviewExecutionCommand.ts`
- Modify: `src/application/review/reviewExecution/ReviewExecutionDto.ts`
- Modify: `src/application/review/reviewExecution/__tests__/ReviewExecutionService.test.ts`

**Step 1: テストを追加**

ReviewExecutionService.test.tsに以下のテストを追加:
- suggest有効時: `getSuggestDiscussions` が呼ばれること
- activeSuggestsの絞り込み: hasChangedSinceNote=true / チェックリスト外 のsuggestが除外されること
- ワークフローパラメータに `suggestEnabledRatingLabels`, `activeSuggests`, `suggestResultFilePath` が渡されること
- DtoにsuggestionsとSHA情報が含まれること
- suggest無効時（空配列）: `getSuggestDiscussions` は呼ばれるがactiveSuggestsは空配列

**Step 2: テストが失敗することを確認**

**Step 3: ReviewExecutionCommand, ReviewExecutionDtoを拡張**

`ReviewExecutionCommand` に `suggestEnabledRatingLabels: string[]` を追加。
`ReviewExecutionDto` に `suggestions`, `baseSha`, `headSha`, `startSha` を追加。

**Step 4: ReviewExecutionServiceを拡張**

`execute()` 内で:
1. `getSuggestDiscussions` を `getReviewDiscussions` と並列で呼び出し
2. `activeSuggests` / `suggestsToResolve` を算出
3. ワークフローパラメータに追加
4. ワークフロー結果からsuggestionsを抽出してDtoに含める
5. `baseSha`, `headSha`, `startSha` をDtoに含める

**Step 5: テストがパスすることを確認**

Run: `npx vitest run src/application/review/reviewExecution/`
Expected: PASS

**Step 6: コミット**

```bash
git add src/application/review/reviewExecution/
git commit -m "feat: extend ReviewExecutionService to collect active suggests and pass to workflow"
```

---

### Task 11: アプリケーション層 — CommentPostingService拡張

**Files:**
- Modify: `src/application/review/commentPosting/CommentPostingService.ts`
- Modify: `src/application/review/commentPosting/CommentPostingCommand.ts`
- Modify: `src/application/review/commentPosting/__tests__/CommentPostingService.test.ts`

**Step 1: テストを追加**

- suggest投稿: `postSuggestDiscussion` が各suggestに対して呼ばれること（SuggestCommentFormatterで整形されたbody + position）
- suggest resolve: `resolveDiscussion` が各resolve対象に対して呼ばれること
- suggestが空の場合: suggest関連メソッドは呼ばれないこと
- 既存のレビュー結果投稿が引き続き動作すること

**Step 2: テストが失敗することを確認**

**Step 3: CommentPostingCommandを拡張**

`suggestions: ResolvedSuggestion[]`, `suggestDiscussionsToResolve: SuggestDiscussion[]`, `baseSha`, `headSha`, `startSha` を追加。

**Step 4: CommentPostingServiceを拡張**

`execute()` 内で:
1. 既存: レビュー結果コメント投稿
2. 新規: `suggestDiscussionsToResolve` の各discussionを `resolveDiscussion` で解決
3. 新規: `suggestions` の各suggestを `SuggestCommentFormatter.format()` + `postSuggestDiscussion` で投稿

**Step 5: テストがパスすることを確認**

Run: `npx vitest run src/application/review/commentPosting/`
Expected: PASS

**Step 6: コミット**

```bash
git add src/application/review/commentPosting/
git commit -m "feat: extend CommentPostingService to resolve old suggests and post new suggest discussions"
```

---

### Task 12: Mastra層 — storeSuggestツール

**Files:**
- Create: `src/mastra/review/tools/storeSuggest.ts`
- Create: `src/mastra/review/tools/__tests__/storeSuggest.test.ts`
- Create: `src/mastra/review/suggestTypes.ts`

**Step 1: 保存形式の型定義を作成**

```typescript
// src/mastra/review/suggestTypes.ts
import { z } from 'zod';
import * as fs from 'node:fs';

export const storedSuggestionSchema = z.object({
  checkItemId: z.number(),
  checkItemContent: z.string(),
  filePath: z.string(),
  originalCode: z.string(),
  suggestedCode: z.string(),
  comment: z.string(),
  newLine: z.number(),
  linesAbove: z.number(),
  linesBelow: z.number(),
  oldPath: z.string(),
  newPath: z.string(),
});

export type StoredSuggestion = z.infer<typeof storedSuggestionSchema>;

export function readStoredSuggestions(filePath: string): StoredSuggestion[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as StoredSuggestion[];
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw e;
  }
}
```

**Step 2: テストを書く**

`storeReviewResult.test.ts` のパターンに倣い、RequestContext + tmpFileベースのテスト:
- 正常系: suggestが保存されること
- checkItemId不正: エラーメッセージが返ること
- 行数上限超過（201行超）: エラーメッセージが返ること
- 重複チェック（同一filePath + originalCode）: エラーメッセージが返ること
- activeSuggestsとの重複チェック: エラーメッセージが返ること
- 行番号解決失敗（0件マッチ）: エラーメッセージが返ること
- 行番号解決失敗（複数マッチ）: エラーメッセージが返ること
- 行番号解決成功: 解決済み情報が保存されること

**Step 3: テストが失敗することを確認**

**Step 4: storeSuggestツールを実装**

`storeReviewResult` と同じパターン（ファイルロック方式）で実装。
RequestContextから取得するもの:
- `checkItems`: IndexedCheckItem[] (checkItemId → checkItemContent変換)
- `activeSuggests`: 以前の有効suggest
- `suggestionLineResolver`: SuggestionLineResolver
- `fullMrDiff`: 圧縮前のフルdiff
- `suggestResultFilePath`: suggest専用の結果ファイルパス

**Step 5: テストがパスすることを確認**

Run: `npx vitest run src/mastra/review/tools/__tests__/storeSuggest.test.ts`
Expected: PASS

**Step 6: コミット**

```bash
git add src/mastra/review/tools/storeSuggest.ts src/mastra/review/tools/__tests__/storeSuggest.test.ts src/mastra/review/suggestTypes.ts
git commit -m "feat: implement storeSuggest tool with line resolution and validation"
```

---

### Task 13: Mastra層 — getSuggestsツール

**Files:**
- Create: `src/mastra/review/tools/getSuggests.ts`
- Create: `src/mastra/review/tools/__tests__/getSuggests.test.ts`

**Step 1: テストを書く**

- 空の場合: 空配列が返ること
- 保存済みsuggest: `source: 'current'` で返ること
- activeSuggests（prior）: `source: 'prior'` で返ること
- フィルタリング: 担当チェック項目のsuggestのみが返ること

**Step 2: テストが失敗することを確認**

**Step 3: getSuggestsツールを実装**

RequestContextから `checkItems`, `activeSuggests`, `suggestResultFilePath` を取得し、担当チェック項目でフィルタして返却。

**Step 4: テストがパスすることを確認**

Run: `npx vitest run src/mastra/review/tools/__tests__/getSuggests.test.ts`
Expected: PASS

**Step 5: コミット**

```bash
git add src/mastra/review/tools/getSuggests.ts src/mastra/review/tools/__tests__/getSuggests.test.ts
git commit -m "feat: implement getSuggests tool with filtering by assigned check items"
```

---

### Task 14: Mastra層 — reviewAgent拡張（ツール登録 + プロンプト）

**Files:**
- Modify: `src/mastra/review/agents/reviewAgent.ts`
- Modify: `src/mastra/review/requestContext.ts`
- Modify: `src/mastra/review/agents/__tests__/reviewAgent.test.ts` (存在する場合)

**Step 1: ReviewAgentRequestContextを拡張**

`src/mastra/review/requestContext.ts` に追加:

```typescript
// suggest関連
suggestEnabledRatingLabels: string[];
suggestResultFilePath: string;
fullMrDiff: string;  // 圧縮前のフルdiff（行番号解決用）
activeSuggests: Array<{
  checkItemContent: string;
  filePath: string;
  originalCode: string;
  suggestedCode: string;
  comment: string;
}> | null;
suggestionLineResolver: SuggestionLineResolver | null;
```

**Step 2: buildInstructionsを拡張**

- 冒頭の役割定義を `suggestEnabledRatingLabels` が空でない場合に切り替え
- suggest有効時のみ `## Code Suggestion Guidelines` セクションを追加
- Tool Referenceセクションに `storeSuggest`, `getSuggests` の説明を追加
- Completion Requirementsにsuggest完了確認を追加

**Step 3: buildUserPromptを拡張**

`src/application/shared/prompt/UserPromptTemplate.ts` を拡張し、`activeSuggests` パラメータを追加。有効なsuggestがある場合に `## Active Suggestions from Prior Reviews` セクションを追加。

**Step 4: ツール動的登録を拡張**

`reviewAgent` の `tools` コールバックで `suggestEnabledRatingLabels` が空でない場合に `storeSuggest` / `getSuggests` を追加登録。

**Step 5: テスト実行**

Run: `npx vitest run src/mastra/review/`
Expected: PASS

**Step 6: コミット**

```bash
git add src/mastra/review/ src/application/shared/prompt/
git commit -m "feat: extend reviewAgent with suggest tools, prompts, and dynamic registration"
```

---

### Task 15: Mastra層 — reviewWorkflow拡張

**Files:**
- Modify: `src/mastra/review/workflows/reviewWorkflow.ts`
- Modify: `src/application/shared/port/workflow/ReviewWorkflowRunner.ts`
- Modify: `src/infrastructure/adapter/review/workflow/MastraReviewWorkflowRunner.ts`

**Step 1: ReviewWorkflowParams / ReviewWorkflowResult を拡張**

`ReviewWorkflowRunner.ts`:
- `ReviewWorkflowParams` に `suggestEnabledRatingLabels`, `activeSuggests`, `suggestResultFilePath`, `fullMrDiff`（圧縮前diff）を追加
- `ReviewWorkflowResult` に `suggestions` 配列を追加

**Step 2: workflowInputSchema / workflowOutputSchemaを拡張**

`reviewWorkflow.ts`:
- 入力スキーマに suggest関連フィールドを追加
- 出力スキーマに suggestions を追加

**Step 3: reviewExecutionStepを拡張**

`reviewExecutionStep` 内で:
- `DiffBasedSuggestionLineResolver` インスタンスを生成
- `suggestResultFilePath` をグループごとにユニークに生成
- agentRequestContextに suggest関連データを設定
- `activeSuggests` をグループのチェック項目でフィルタ
- 実行後に `readStoredSuggestions` で結果を読み取り、resultsと共に返却

**Step 4: workflowの最終mapステップでsuggestionsをフラット化**

**Step 5: MastraReviewWorkflowRunnerを更新**

新しいパラメータをinputDataに含めるよう修正。

**Step 6: テスト実行**

Run: `npx vitest run src/mastra/review/workflows/ src/infrastructure/adapter/review/workflow/`
Expected: PASS

**Step 7: コミット**

```bash
git add src/mastra/review/workflows/ src/application/shared/port/workflow/ src/infrastructure/adapter/review/workflow/
git commit -m "feat: extend reviewWorkflow to support suggest generation and result collection"
```

---

### Task 16: プレゼンテーション層 — CLI拡張

**Files:**
- Modify: `src/cli/review/index.ts`
- Modify: `src/cli/review/commandBuilder.ts`
- Modify: `src/cli/review/parseReviewArgs.ts` (必要に応じて)

**Step 1: commandBuilderを拡張**

`buildLocalReviewCommand` に `suggestEnabledRatingLabels` を追加。
`buildApiReviewRequest` に `suggestEnabledRatingLabels` を追加。

**Step 2: CLI index.tsを拡張**

ローカルモード:
- `ReviewExecutionDto` から `suggestions`, `baseSha`, `headSha`, `startSha` を取得
- `CommentPostingCommand` に suggest関連フィールドを含める

APIモード:
- `ReviewApiRequest` に `suggestEnabledRatingLabels` を含める
- `ReviewApiResponse` から suggest関連データを取得
- `CommentPostingCommand` に suggest関連フィールドを含める

**Step 3: テスト実行**

Run: `npx vitest run src/cli/review/`
Expected: PASS

**Step 4: コミット**

```bash
git add src/cli/review/
git commit -m "feat: extend review CLI to pass suggestEnabledRatingLabels and handle suggest results"
```

---

### Task 17: プレゼンテーション層 — APIサーバー拡張

**Files:**
- Modify: `src/presentation/api/review/reviewHandler.ts`
- Modify: `src/presentation/api/review/reviewRoute.ts` (必要に応じて)
- Modify: `src/infrastructure/adapter/review/apiClient/ReviewApiClient.ts`

**Step 1: reviewHandlerを拡張**

- `reviewRequestSchema` に `suggestEnabledRatingLabels` を追加（optional, default: `['C']`）
- `buildReviewSettings` ヘルパーに `suggestEnabledRatingLabels` を含める
- SSEレスポンスの `result` イベントに `suggestions`, `baseSha`, `headSha`, `startSha` を含める

**Step 2: ReviewApiClientを拡張**

- `ReviewApiRequest` に `suggestEnabledRatingLabels` を追加（optional）
- `ReviewApiResponse` に `suggestions`, `baseSha`, `headSha`, `startSha` を追加

**Step 3: テスト実行**

Run: `npx vitest run src/presentation/api/review/ src/infrastructure/adapter/review/apiClient/`
Expected: PASS

**Step 4: コミット**

```bash
git add src/presentation/api/review/ src/infrastructure/adapter/review/apiClient/
git commit -m "feat: extend API server and client to support suggest feature"
```

---

### Task 18: 環境変数・設定ファイル更新

**Files:**
- Modify: `.env.example` (必要に応じて)
- Modify: `.ci-template/variable/review.yml` (必要に応じて)

**Step 1: 設定ファイル確認**

`suggestEnabledRatingLabels` はreview-settings.jsonで管理されるため、新しい環境変数は不要。ただし、`.ci-template` のサンプル設定ファイルにsuggest設定の例を追加する必要があるか確認。

**Step 2: 必要に応じて更新してコミット**

```bash
git add .env.example .ci-template/
git commit -m "docs: add suggestEnabledRatingLabels to example configuration"
```

---

### Task 19: 設計書の更新

**Files:**
- Modify: `docs/domain/review/entity.md`
- Modify: `docs/domain/review/business_rule.md`
- Modify: `docs/domain/review/usecase.md`
- Modify: `docs/archtecture/review/overallflow_concept.md`

**Step 1: ドメインドキュメントにSuggestion関連を追記**

- entity.md: Suggestion, ResolvedSuggestion の説明追加
- business_rule.md: suggest有効/無効の判定ルール、重複排除ルール、自動resolveルール追加
- usecase.md: suggest生成・投稿のユースケース追加
- overallflow_concept.md: suggestの処理フローを追記

**Step 2: コミット**

```bash
git add docs/
git commit -m "docs: update domain and architecture documents for suggest feature"
```

---

### Task 20: 統合テスト + パラメータ伝播テスト

**Files:**
- Create or Modify: テストファイル（各層間のパラメータ伝播確認）

**Step 1: パラメータ伝播テストを作成/更新**

AGENTS.mdの注意事項「適切なタイミングで他層間のパラメータ伝播テストを新規作成・更新すること」に従い:

- CLI → ReviewExecutionCommand: `suggestEnabledRatingLabels` が正しく渡ること
- ReviewExecutionService → ReviewWorkflowParams: suggest関連パラメータが正しく渡ること
- ReviewWorkflowParams → RequestContext: suggest関連データがRequestContextに正しく設定されること
- ReviewExecutionDto → CommentPostingCommand: suggestions, SHA情報が正しく渡ること
- APIリクエスト → APIレスポンス: suggest関連データがSSE経由で正しく伝達されること

**Step 2: 全テスト実行**

Run: `npx vitest run`
Expected: PASS (全テスト)

**Step 3: カバレッジ確認**

Run: `npx vitest run --coverage`
Expected: 新規実装部分の条件カバレッジ80%以上

**Step 4: ビルド確認**

Run: `npm run build:cli`
Expected: ビルド成功

**Step 5: 型チェック確認**

Run: `npx tsc --noEmit`
Expected: 新規実装部分に型エラーなし

**Step 6: Lint/Format確認**

Run: `npm run lint && npm run format:check`
Expected: エラーなし

**Step 7: コミット**

```bash
git add -A
git commit -m "test: add parameter propagation tests and verify integration for suggest feature"
```
