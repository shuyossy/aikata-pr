# PBI ID:1 システム処理フロー Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the AI-powered MR review system processing flow (Steps 0-3) as designed in `docs/plans/2026-03-27-pbi1-design.md`.

**Architecture:** Clean Architecture (Domain → Application → Infrastructure → Presentation). Steps 0/3 in Application layer via Gateways. Steps 1-2 in Mastra Workflow. TDD throughout.

**Tech Stack:** TypeScript, Mastra (@mastra/core v1.16.0), Zod v4, Pino, Vitest, GitLab REST API

**Prerequisites:**
- Before any Mastra code, load the `mastra` skill and verify API against embedded docs in `node_modules/@mastra/core/dist/docs/`
- Existing test patterns: see `src/lib/__tests__/cli.test.ts`
- Build command: `npm run build:cli`
- Test command: `npm run test`

---

## Phase 1: Domain Layer

### Task 1: CheckItem Entity

**Files:**
- Create: `src/domain/checkItem/CheckItem.ts`
- Create: `src/domain/checkItem/index.ts`
- Test: `src/domain/checkItem/__tests__/CheckItem.test.ts`

**Step 1: Write the failing test**

```typescript
// src/domain/checkItem/__tests__/CheckItem.test.ts
import { describe, it, expect } from 'vitest';
import { CheckItem } from '../CheckItem.js';

describe('CheckItem', () => {
  it('contentを保持する', () => {
    const item = new CheckItem('コードの可読性が保たれているか');
    expect(item.content).toBe('コードの可読性が保たれているか');
  });

  it('contentが空文字の場合はエラーになる', () => {
    expect(() => new CheckItem('')).toThrow();
  });

  it('同じcontentを持つCheckItemは等価である', () => {
    const a = new CheckItem('test');
    const b = new CheckItem('test');
    expect(a.equals(b)).toBe(true);
  });

  it('異なるcontentを持つCheckItemは等価でない', () => {
    const a = new CheckItem('test1');
    const b = new CheckItem('test2');
    expect(a.equals(b)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/domain/checkItem/__tests__/CheckItem.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/domain/checkItem/CheckItem.ts
export class CheckItem {
  readonly content: string;

  constructor(content: string) {
    if (content.trim() === '') {
      throw new Error('CheckItem content must not be empty');
    }
    this.content = content;
  }

  equals(other: CheckItem): boolean {
    return this.content === other.content;
  }
}
```

```typescript
// src/domain/checkItem/index.ts
export { CheckItem } from './CheckItem.js';
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/domain/checkItem/__tests__/CheckItem.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/domain/checkItem/
git commit -m "feat: add CheckItem entity"
```

---

### Task 2: Rating Value Object

**Files:**
- Create: `src/domain/rating/Rating.ts`
- Create: `src/domain/rating/index.ts`
- Test: `src/domain/rating/__tests__/Rating.test.ts`

**Step 1: Write the failing test**

```typescript
// src/domain/rating/__tests__/Rating.test.ts
import { describe, it, expect } from 'vitest';
import { Rating } from '../Rating.js';

describe('Rating', () => {
  it('labelとdefinitionを保持する', () => {
    const rating = new Rating('A', 'チェック項目の要件を完全に満たしている');
    expect(rating.label).toBe('A');
    expect(rating.definition).toBe('チェック項目の要件を完全に満たしている');
  });

  it('labelが空文字の場合はエラーになる', () => {
    expect(() => new Rating('', 'definition')).toThrow();
  });

  it('definitionが空文字の場合はエラーになる', () => {
    expect(() => new Rating('A', '')).toThrow();
  });

  it('同じlabelとdefinitionを持つRatingは等価である', () => {
    const a = new Rating('A', 'def');
    const b = new Rating('A', 'def');
    expect(a.equals(b)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/domain/rating/__tests__/Rating.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/domain/rating/Rating.ts
export class Rating {
  readonly label: string;
  readonly definition: string;

  constructor(label: string, definition: string) {
    if (label.trim() === '') {
      throw new Error('Rating label must not be empty');
    }
    if (definition.trim() === '') {
      throw new Error('Rating definition must not be empty');
    }
    this.label = label;
    this.definition = definition;
  }

  equals(other: Rating): boolean {
    return this.label === other.label && this.definition === other.definition;
  }
}
```

```typescript
// src/domain/rating/index.ts
export { Rating } from './Rating.js';
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/domain/rating/__tests__/Rating.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/domain/rating/
git commit -m "feat: add Rating value object"
```

---

### Task 3: ReviewResult Entity

**Files:**
- Create: `src/domain/reviewResult/ReviewResult.ts`
- Create: `src/domain/reviewResult/index.ts`
- Test: `src/domain/reviewResult/__tests__/ReviewResult.test.ts`

**Step 1: Write the failing test**

```typescript
// src/domain/reviewResult/__tests__/ReviewResult.test.ts
import { describe, it, expect } from 'vitest';
import { ReviewResult } from '../ReviewResult.js';
import { CheckItem } from '../../checkItem/index.js';
import { Rating } from '../../rating/index.js';

describe('ReviewResult', () => {
  const checkItem = new CheckItem('コードの可読性');
  const rating = new Rating('A', '完全に満たしている');

  it('正常なレビュー結果を生成できる', () => {
    const result = ReviewResult.success(checkItem, rating, 'コメント内容');
    expect(result.checkItem).toBe(checkItem);
    expect(result.rating).toBe(rating);
    expect(result.comment).toBe('コメント内容');
    expect(result.isError).toBe(false);
    expect(result.errorMessage).toBeUndefined();
  });

  it('エラーのレビュー結果を生成できる', () => {
    const result = ReviewResult.error(checkItem, 'Timeout occurred');
    expect(result.checkItem).toBe(checkItem);
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('Timeout occurred');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/domain/reviewResult/__tests__/ReviewResult.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/domain/reviewResult/ReviewResult.ts
import { CheckItem } from '../checkItem/index.js';
import { Rating } from '../rating/index.js';

export class ReviewResult {
  readonly checkItem: CheckItem;
  readonly comment: string;
  readonly rating: Rating;
  readonly isError: boolean;
  readonly errorMessage?: string;

  private constructor(
    checkItem: CheckItem,
    comment: string,
    rating: Rating,
    isError: boolean,
    errorMessage?: string,
  ) {
    this.checkItem = checkItem;
    this.comment = comment;
    this.rating = rating;
    this.isError = isError;
    this.errorMessage = errorMessage;
  }

  static success(checkItem: CheckItem, rating: Rating, comment: string): ReviewResult {
    return new ReviewResult(checkItem, comment, rating, false);
  }

  static error(checkItem: CheckItem, errorMessage: string): ReviewResult {
    // エラー時はダミーの評定を使用
    const errorRating = new Rating('エラー', 'エラーが発生しました');
    return new ReviewResult(checkItem, errorMessage, errorRating, true, errorMessage);
  }
}
```

```typescript
// src/domain/reviewResult/index.ts
export { ReviewResult } from './ReviewResult.js';
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/domain/reviewResult/__tests__/ReviewResult.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/domain/reviewResult/
git commit -m "feat: add ReviewResult entity"
```

---

### Task 4: ReviewSettings Value Object

**Files:**
- Create: `src/domain/reviewSettings/ReviewSettings.ts`
- Create: `src/domain/reviewSettings/index.ts`
- Test: `src/domain/reviewSettings/__tests__/ReviewSettings.test.ts`

**Step 1: Write the failing test**

```typescript
// src/domain/reviewSettings/__tests__/ReviewSettings.test.ts
import { describe, it, expect } from 'vitest';
import { ReviewSettings } from '../ReviewSettings.js';
import { Rating } from '../../rating/index.js';

describe('ReviewSettings', () => {
  it('全てのフィールドを指定して生成できる', () => {
    const ratings = [
      new Rating('A', '完全に満たしている'),
      new Rating('B', '概ね満たしている'),
    ];
    const settings = new ReviewSettings({
      additionalInstructions: '追加指示',
      concurrentReviewCount: 3,
      commentFormat: '{comment}',
      ratings,
    });
    expect(settings.additionalInstructions).toBe('追加指示');
    expect(settings.concurrentReviewCount).toBe(3);
    expect(settings.commentFormat).toBe('{comment}');
    expect(settings.ratings).toEqual(ratings);
  });

  it('デフォルト値で生成できる', () => {
    const settings = ReviewSettings.default();
    expect(settings.additionalInstructions).toBe('');
    expect(settings.concurrentReviewCount).toBe(1);
    expect(settings.commentFormat).not.toBe('');
    expect(settings.ratings.length).toBe(3);
  });

  it('concurrentReviewCountが0以下の場合はエラーになる', () => {
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: 0,
          commentFormat: '{comment}',
          ratings: [new Rating('A', 'def')],
        }),
    ).toThrow();
  });

  it('ratingsが空の場合はエラーになる', () => {
    expect(
      () =>
        new ReviewSettings({
          additionalInstructions: '',
          concurrentReviewCount: 1,
          commentFormat: '{comment}',
          ratings: [],
        }),
    ).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/domain/reviewSettings/__tests__/ReviewSettings.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/domain/reviewSettings/ReviewSettings.ts
import { Rating } from '../rating/index.js';

const DEFAULT_COMMENT_FORMAT = '{comment}';
const DEFAULT_RATINGS = [
  new Rating('A', 'チェック項目の要件を完全に満たしている'),
  new Rating('B', '概ね満たしているが軽微な指摘がある'),
  new Rating('C', '要件を満たしていない'),
];

interface ReviewSettingsParams {
  additionalInstructions: string;
  concurrentReviewCount: number;
  commentFormat: string;
  ratings: Rating[];
}

export class ReviewSettings {
  readonly additionalInstructions: string;
  readonly concurrentReviewCount: number;
  readonly commentFormat: string;
  readonly ratings: Rating[];

  constructor(params: ReviewSettingsParams) {
    if (params.concurrentReviewCount < 1) {
      throw new Error('concurrentReviewCount must be at least 1');
    }
    if (params.ratings.length === 0) {
      throw new Error('ratings must not be empty');
    }
    this.additionalInstructions = params.additionalInstructions;
    this.concurrentReviewCount = params.concurrentReviewCount;
    this.commentFormat = params.commentFormat;
    this.ratings = params.ratings;
  }

  static default(): ReviewSettings {
    return new ReviewSettings({
      additionalInstructions: '',
      concurrentReviewCount: 1,
      commentFormat: DEFAULT_COMMENT_FORMAT,
      ratings: DEFAULT_RATINGS,
    });
  }
}
```

```typescript
// src/domain/reviewSettings/index.ts
export { ReviewSettings } from './ReviewSettings.js';
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/domain/reviewSettings/__tests__/ReviewSettings.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/domain/reviewSettings/
git commit -m "feat: add ReviewSettings value object with defaults"
```

---

### Task 5: Checklist Entity with splitByCount

**Files:**
- Create: `src/domain/checklist/Checklist.ts`
- Create: `src/domain/checklist/index.ts`
- Test: `src/domain/checklist/__tests__/Checklist.test.ts`

**Step 1: Write the failing test**

```typescript
// src/domain/checklist/__tests__/Checklist.test.ts
import { describe, it, expect } from 'vitest';
import { Checklist } from '../Checklist.js';
import { CheckItem } from '../../checkItem/index.js';

describe('Checklist', () => {
  const items = [
    new CheckItem('item1'),
    new CheckItem('item2'),
    new CheckItem('item3'),
    new CheckItem('item4'),
    new CheckItem('item5'),
  ];

  it('チェック項目一覧を保持する', () => {
    const checklist = new Checklist(items);
    expect(checklist.items).toEqual(items);
    expect(checklist.size).toBe(5);
  });

  it('空のチェック項目一覧ではエラーになる', () => {
    expect(() => new Checklist([])).toThrow();
  });

  describe('splitByCount', () => {
    it('指定数ごとに均等に分割できる（割り切れる場合）', () => {
      const checklist = new Checklist([
        new CheckItem('a'),
        new CheckItem('b'),
        new CheckItem('c'),
        new CheckItem('d'),
      ]);
      const groups = checklist.splitByCount(2);
      expect(groups.length).toBe(2);
      expect(groups[0].length).toBe(2);
      expect(groups[1].length).toBe(2);
    });

    it('指定数ごとに分割できる（端数あり）', () => {
      const checklist = new Checklist(items); // 5 items
      const groups = checklist.splitByCount(3);
      expect(groups.length).toBe(2);
      expect(groups[0].length).toBe(3);
      expect(groups[1].length).toBe(2);
    });

    it('全項目が過不足なく含まれる', () => {
      const checklist = new Checklist(items);
      const groups = checklist.splitByCount(2);
      const flattened = groups.flat();
      expect(flattened.length).toBe(items.length);
      for (const item of items) {
        expect(flattened.some((f) => f.equals(item))).toBe(true);
      }
    });

    it('countが総項目数以上の場合は1グループになる', () => {
      const checklist = new Checklist(items);
      const groups = checklist.splitByCount(10);
      expect(groups.length).toBe(1);
      expect(groups[0].length).toBe(5);
    });

    it('countが1の場合は各項目が個別グループになる', () => {
      const checklist = new Checklist(items);
      const groups = checklist.splitByCount(1);
      expect(groups.length).toBe(5);
      groups.forEach((g) => expect(g.length).toBe(1));
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/domain/checklist/__tests__/Checklist.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/domain/checklist/Checklist.ts
import { CheckItem } from '../checkItem/index.js';

export class Checklist {
  readonly items: CheckItem[];

  constructor(items: CheckItem[]) {
    if (items.length === 0) {
      throw new Error('Checklist must contain at least one item');
    }
    this.items = [...items];
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * 指定された数ごとにチェック項目を機械的に分割する
   */
  splitByCount(count: number): CheckItem[][] {
    if (count >= this.items.length) {
      return [[...this.items]];
    }
    const groups: CheckItem[][] = [];
    for (let i = 0; i < this.items.length; i += count) {
      groups.push(this.items.slice(i, i + count));
    }
    return groups;
  }
}
```

```typescript
// src/domain/checklist/index.ts
export { Checklist } from './Checklist.js';
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/domain/checklist/__tests__/Checklist.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/domain/checklist/
git commit -m "feat: add Checklist entity with splitByCount"
```

---

### Task 6: MrContext and PriorReviewContext Value Objects

**Files:**
- Create: `src/domain/mrContext/MrContext.ts`
- Create: `src/domain/mrContext/index.ts`
- Create: `src/domain/priorReviewContext/PriorReviewContext.ts`
- Create: `src/domain/priorReviewContext/index.ts`
- Test: `src/domain/mrContext/__tests__/MrContext.test.ts`
- Test: `src/domain/priorReviewContext/__tests__/PriorReviewContext.test.ts`

**Step 1: Write failing tests**

```typescript
// src/domain/mrContext/__tests__/MrContext.test.ts
import { describe, it, expect } from 'vitest';
import { MrContext } from '../MrContext.js';

describe('MrContext', () => {
  it('全てのフィールドを保持する', () => {
    const ctx = new MrContext({
      title: 'Fix bug',
      description: 'Bug fix description',
      sourceBranch: 'feature/fix',
      targetBranch: 'main',
      diff: '--- a/file\n+++ b/file',
      commitHash: 'abc1234',
    });
    expect(ctx.title).toBe('Fix bug');
    expect(ctx.description).toBe('Bug fix description');
    expect(ctx.sourceBranch).toBe('feature/fix');
    expect(ctx.targetBranch).toBe('main');
    expect(ctx.diff).toBe('--- a/file\n+++ b/file');
    expect(ctx.commitHash).toBe('abc1234');
  });
});
```

```typescript
// src/domain/priorReviewContext/__tests__/PriorReviewContext.test.ts
import { describe, it, expect } from 'vitest';
import { PriorReviewContext } from '../PriorReviewContext.js';
import { ReviewResult } from '../../reviewResult/index.js';
import { CheckItem } from '../../checkItem/index.js';
import { Rating } from '../../rating/index.js';

describe('PriorReviewContext', () => {
  it('前回レビュー結果とその後の変更情報を保持する', () => {
    const result = ReviewResult.success(
      new CheckItem('item'),
      new Rating('A', 'good'),
      'comment',
    );
    const ctx = new PriorReviewContext({
      results: [result],
      commitMessages: ['fix: something'],
      diffSincePrior: '--- a/file\n+++ b/file',
    });
    expect(ctx.results).toHaveLength(1);
    expect(ctx.commitMessages).toEqual(['fix: something']);
    expect(ctx.diffSincePrior).toBe('--- a/file\n+++ b/file');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- src/domain/mrContext src/domain/priorReviewContext`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/domain/mrContext/MrContext.ts
interface MrContextParams {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  diff: string;
  commitHash: string;
}

export class MrContext {
  readonly title: string;
  readonly description: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly diff: string;
  readonly commitHash: string;

  constructor(params: MrContextParams) {
    this.title = params.title;
    this.description = params.description;
    this.sourceBranch = params.sourceBranch;
    this.targetBranch = params.targetBranch;
    this.diff = params.diff;
    this.commitHash = params.commitHash;
  }
}
```

```typescript
// src/domain/mrContext/index.ts
export { MrContext } from './MrContext.js';
```

```typescript
// src/domain/priorReviewContext/PriorReviewContext.ts
import { ReviewResult } from '../reviewResult/index.js';

interface PriorReviewContextParams {
  results: ReviewResult[];
  commitMessages: string[];
  diffSincePrior: string;
}

export class PriorReviewContext {
  readonly results: ReviewResult[];
  readonly commitMessages: string[];
  readonly diffSincePrior: string;

  constructor(params: PriorReviewContextParams) {
    this.results = params.results;
    this.commitMessages = params.commitMessages;
    this.diffSincePrior = params.diffSincePrior;
  }
}
```

```typescript
// src/domain/priorReviewContext/index.ts
export { PriorReviewContext } from './PriorReviewContext.js';
```

**Step 4: Run tests to verify they pass**

Run: `npm run test -- src/domain/mrContext src/domain/priorReviewContext`
Expected: PASS

**Step 5: Commit**

```bash
git add src/domain/mrContext/ src/domain/priorReviewContext/
git commit -m "feat: add MrContext and PriorReviewContext value objects"
```

---

## Phase 2: Application Layer - Ports & Helpers

### Task 7: Gateway Interfaces

**Files:**
- Create: `src/application/shared/port/gateway/MrGateway.ts`
- Create: `src/application/shared/port/gateway/MrCommentGateway.ts`
- Create: `src/application/shared/port/gateway/index.ts`

No tests needed for interfaces.

**Step 1: Write interfaces**

```typescript
// src/application/shared/port/gateway/MrGateway.ts
import { MrContext } from '../../../../domain/mrContext/index.js';

export interface MrGateway {
  getMrContext(projectId: string, mrIid: string): Promise<MrContext>;
  getCommitsSince(projectId: string, mrIid: string, sinceCommitHash: string): Promise<string[]>;
  getDiffSince(projectId: string, mrIid: string, sinceCommitHash: string): Promise<string>;
}
```

```typescript
// src/application/shared/port/gateway/MrCommentGateway.ts
export interface MrComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface MrCommentGateway {
  getComments(projectId: string, mrIid: string): Promise<MrComment[]>;
  postComment(projectId: string, mrIid: string, body: string): Promise<void>;
}
```

```typescript
// src/application/shared/port/gateway/index.ts
export type { MrGateway } from './MrGateway.js';
export type { MrCommentGateway, MrComment } from './MrCommentGateway.js';
```

**Step 2: Commit**

```bash
git add src/application/shared/
git commit -m "feat: add MrGateway and MrCommentGateway port interfaces"
```

---

### Task 8: Comment Formatter

MRコメント投稿用のMarkdown整形ロジック。マーカー埋め込み、表生成、15項目超の折りたたみを担当。

**Files:**
- Create: `src/application/shared/comment/CommentFormatter.ts`
- Create: `src/application/shared/comment/index.ts`
- Test: `src/application/shared/comment/__tests__/CommentFormatter.test.ts`

**Step 1: Write the failing test**

テストケース:
1. 基本的なMarkdown表を生成できる
2. マーカーが含まれている
3. メタデータマーカーに評定基準とコミットハッシュが含まれている
4. エラー結果は評定欄に「エラー」が表示される
5. 15項目超の場合は折りたたみ形式になる
6. 15項目以下の場合は折りたたみにならない

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/application/shared/comment/__tests__/CommentFormatter.test.ts`

**Step 3: Write implementation**

定数:
- `REVIEW_MARKER = '<!-- aikata-review -->'`
- `REVIEW_DATA_PREFIX = '<!-- aikata-review-data: '`
- `REVIEW_DATA_SUFFIX = ' -->'`
- `FOLD_THRESHOLD = 15`

`formatComment(results: ReviewResult[], ratings: Rating[], commitHash: string): string` メソッドを実装。

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git commit -m "feat: add CommentFormatter for MR comment generation"
```

---

### Task 9: Comment Parser

MRコメントからチェック結果を抽出するパーサー。マーカー識別、メタデータ復元、表パースを担当。

**Files:**
- Create: `src/application/shared/comment/CommentParser.ts`
- Test: `src/application/shared/comment/__tests__/CommentParser.test.ts`

**Step 1: Write the failing test**

テストケース:
1. マーカー付きコメントからレビュー結果をパースできる
2. マーカーのないコメントはnullを返す
3. メタデータからRating定義を復元できる
4. メタデータからコミットハッシュを復元できる
5. 折りたたみ形式のコメントもパースできる
6. エラー行を正しくパースできる

**Step 2: Run test to verify it fails**

**Step 3: Write implementation**

`parseComment(body: string): ParsedReviewComment | null` メソッドを実装。

`ParsedReviewComment`:
- `results: ReviewResult[]`
- `ratings: Rating[]`
- `commitHash: string`

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git commit -m "feat: add CommentParser for extracting prior review results"
```

---

### Task 10: Input File Parsers

チェックリストCSVとレビュー設定JSONのパーサー。

**Files:**
- Create: `src/application/shared/parser/ChecklistParser.ts`
- Create: `src/application/shared/parser/ReviewSettingsParser.ts`
- Create: `src/application/shared/parser/index.ts`
- Test: `src/application/shared/parser/__tests__/ChecklistParser.test.ts`
- Test: `src/application/shared/parser/__tests__/ReviewSettingsParser.test.ts`

**Step 1: Write failing tests**

ChecklistParser テストケース:
1. CSV文字列からChecklistを生成できる
2. 空行は無視される
3. 空のCSVではエラーになる

ReviewSettingsParser テストケース:
1. 全フィールド指定のJSONをパースできる
2. 部分指定の場合はデフォルト値が適用される
3. 空のJSONでは全てデフォルト値になる
4. 不正なJSONではエラーになる
5. concurrentReviewCountが0以下ではエラーになる

ReviewSettingsParserはZodスキーマでバリデーション。

**Step 2: Run tests to verify they fail**

**Step 3: Write implementation**

ReviewSettingsParserのZodスキーマ:
```typescript
import { z } from 'zod/v4';

const reviewSettingsSchema = z.object({
  additionalInstructions: z.string().optional(),
  concurrentReviewCount: z.number().int().min(1).optional(),
  commentFormat: z.string().optional(),
  ratings: z
    .array(
      z.object({
        label: z.string().min(1),
        definition: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
});
```

**Step 4: Run tests to verify they pass**

**Step 5: Commit**

```bash
git commit -m "feat: add ChecklistParser and ReviewSettingsParser"
```

---

### Task 11: ExecuteReview DTOs

**Files:**
- Create: `src/application/executeReview/ExecuteReviewCommand.ts`
- Create: `src/application/executeReview/ExecuteReviewDto.ts`
- Create: `src/application/executeReview/index.ts`

シンプルなデータクラスなのでテスト不要。

**Step 1: Write DTOs**

```typescript
// src/application/executeReview/ExecuteReviewCommand.ts
import { Checklist } from '../../domain/checklist/index.js';
import { ReviewSettings } from '../../domain/reviewSettings/index.js';

export interface ExecuteReviewCommand {
  userId: string;
  projectId: string;
  mrIid: string;
  checklist: Checklist;
  reviewSettings: ReviewSettings;
  skillsPaths: string[];
  aiApiKey: string;
  aiApiEndpointUrl: string;
  aiModelName: string;
  gitlabToken: string;
}
```

```typescript
// src/application/executeReview/ExecuteReviewDto.ts
import { ReviewResult } from '../../domain/reviewResult/index.js';

export interface ExecuteReviewDto {
  results: ReviewResult[];
  commitHash: string;
  commentPosted: boolean;
}
```

```typescript
// src/application/executeReview/index.ts
export type { ExecuteReviewCommand } from './ExecuteReviewCommand.js';
export type { ExecuteReviewDto } from './ExecuteReviewDto.js';
```

**Step 2: Commit**

```bash
git add src/application/executeReview/
git commit -m "feat: add ExecuteReview DTOs"
```

---

## Phase 3: Infrastructure Layer

### Task 12: GitLabApiClient

**Files:**
- Create: `src/infrastructure/adapter/httpClient/GitLabApiClient.ts`
- Create: `src/infrastructure/adapter/httpClient/index.ts`
- Test: `src/infrastructure/adapter/httpClient/__tests__/GitLabApiClient.test.ts`

**Step 1: Write the failing test**

テストケース（Node.js fetch をモック）:
1. GETリクエストにPRIVATE-TOKENヘッダが付与される
2. POSTリクエストでbodyがJSON送信される
3. HTTPステータス401でエラーがスローされる
4. HTTPステータス404でエラーがスローされる
5. ベースURLとパスが正しく結合される

**Step 2: Run test to verify it fails**

**Step 3: Write implementation**

```typescript
// src/infrastructure/adapter/httpClient/GitLabApiClient.ts
export class GitLabApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'PRIVATE-TOKEN': this.token },
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }
}
```

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git commit -m "feat: add GitLabApiClient with auth header support"
```

---

### Task 13: GitLabMrGateway

**Files:**
- Create: `src/infrastructure/adapter/gateway/GitLabMrGateway.ts`
- Create: `src/infrastructure/adapter/gateway/index.ts`
- Test: `src/infrastructure/adapter/gateway/__tests__/GitLabMrGateway.test.ts`

**Step 1: Write the failing test**

GitLabApiClientをモックして、APIレスポンスからMrContextへのマッピングをテスト。

テストケース:
1. getMrContextがMR情報とdiffを正しくマッピングする
2. getCommitsSinceが指定コミット以降のメッセージを返す
3. getDiffSinceが指定コミット以降のdiffを返す

GitLab APIのレスポンス形式:
- `/merge_requests/:iid`: `{ title, description, source_branch, target_branch, sha, diff_refs }`
- `/merge_requests/:iid/changes`: `{ changes: [{ diff }] }`
- `/merge_requests/:iid/commits`: `[{ id, message, created_at }]`

**Step 2-5: Implement, test, commit**

```bash
git commit -m "feat: add GitLabMrGateway implementation"
```

---

### Task 14: GitLabMrCommentGateway

**Files:**
- Create: `src/infrastructure/adapter/gateway/GitLabMrCommentGateway.ts`
- Test: `src/infrastructure/adapter/gateway/__tests__/GitLabMrCommentGateway.test.ts`

**Step 1: Write the failing test**

テストケース:
1. getCommentsがノート一覧をMrComment形式で返す
2. postCommentがPOSTリクエストを送信する

**Step 2-5: Implement, test, commit**

```bash
git commit -m "feat: add GitLabMrCommentGateway implementation"
```

---

## Phase 4: Mastra Layer

> **IMPORTANT:** Before starting this phase, load the `mastra` skill and verify all API usage against embedded docs in `node_modules/@mastra/core/dist/docs/references/`.

### Task 15: Review Result Store Tools

レビュー結果をjsonファイルで管理するMastra Tools。排他制御付き。

**Files:**
- Create: `src/mastra/tools/storeReviewResult.ts`
- Create: `src/mastra/tools/getReviewResults.ts`
- Create: `src/mastra/tools/index.ts`
- Test: `src/mastra/tools/__tests__/storeReviewResult.test.ts`
- Test: `src/mastra/tools/__tests__/getReviewResults.test.ts`

**Step 1: Write the failing test**

storeReviewResult テストケース:
1. レビュー結果をjsonファイルに書き込める
2. 既存の結果に追記できる
3. 同じチェック項目の結果は上書きされる

getReviewResults テストケース:
1. 格納済みのレビュー結果一覧を取得できる
2. 結果がない場合は空配列を返す

排他制御テストケース:
1. 同時に複数のstoreReviewResult呼び出しが競合しない

**Step 2: Run tests to verify they fail**

**Step 3: Write implementation**

Mastra Tool定義パターン（embedded docsの `reference-tools-create-tool.md` を参照）:
- inputSchemaとoutputSchemaをZodで定義
- `createTool()` を使用
- ファイルロックには `Atomics.wait` ベースの簡易mutex or `fs.writeFile` with atomic write パターンを使用

レビュー結果jsonファイルパスはtool実行時のcontextから受け取る。

**Step 4-5: Test, commit**

```bash
git commit -m "feat: add storeReviewResult and getReviewResults Mastra tools"
```

---

### Task 16: Checklist Split Agent

**Files:**
- Create: `src/mastra/agents/checklistSplitAgent.ts`

**Step 1: Write agent definition**

Agentの責務:
- チェックリスト項目群を受け取り、類似項目をグルーピングする
- Structured outputで `{ groups: string[][] }` を返す

Agent定義（embedded docsの `reference-agents-agent.md` を参照）:
- instructions: チェック項目を類似性に基づいてグルーピングする旨
- model: 動的生成（`createOpenAICompatible`）- 関数として外部から渡す

Agentは単体テスト困難（AI呼び出し）なので、Step 19のchecklistSplitStepテスト内でモックして検証。

**Step 2: Commit**

```bash
git commit -m "feat: add checklistSplitAgent definition"
```

---

### Task 17: Checklist Split Step

AI分割 + 機械的調整ロジック。Workflowのstep定義。

**Files:**
- Create: `src/mastra/workflows/steps/checklistSplitStep.ts`
- Test: `src/mastra/workflows/steps/__tests__/checklistSplitStep.test.ts`

**Step 1: Write the failing test**

テストケース:
1. concurrentReviewCount=1の場合、各項目が個別グループになる（AI不使用）
2. concurrentReviewCount>=総項目数の場合、全項目が1グループになる（AI不使用）
3. AI分割が成功し、結果が正しい場合はそのまま返す
4. AI分割結果に漏れがある場合、漏れた項目が補完される
5. AI分割結果に重複がある場合、重複が除去される
6. AI分割結果でグループサイズが超過する場合、分割・再分配される
7. 最終的にconcurrentReviewCount未満のグループは最後の1つだけ
8. AI分割が失敗した場合、機械的分割にフォールバックする

Agent呼び出しはモックする。

**Step 2: Run tests to verify they fail**

**Step 3: Write implementation**

主要ロジック:
- `adjustGroups(groups: CheckItem[][], allItems: CheckItem[], count: number): CheckItem[][]` - AI結果の調整関数
  - 重複除去 → 漏れ補完 → サイズ超過分割 → プール再分配 → 端数保証

**Step 4-5: Test, commit**

```bash
git commit -m "feat: add checklistSplitStep with AI and mechanical fallback"
```

---

### Task 18: Review Agent

**Files:**
- Create: `src/mastra/agents/reviewAgent.ts`

**Step 1: Write agent definition**

Agentの責務:
- MRのコードをレビューし、チェック項目ごとに評定とコメントを付ける
- Workspace toolsでコードベースを調査できる
- storeReviewResult toolで結果を格納する
- getReviewResults toolで結果一覧を確認できる

System prompt構成:
- MRレビューのスペシャリストとしての役割
- レビュー方針・注意点
- チェック項目一覧
- 評定基準（ratings）
- コメントフォーマット
- 追加指示（additionalInstructions）
- 全チェック項目のレビュー完了まで処理を終了しないこと
- レビュー完了時はstoreReviewResult toolを使うこと

Model: `createOpenAICompatible` でuserIdベースで動的生成。

Workspace: `LocalFilesystem` + `LocalSandbox`（basePath: CI_PROJECT_DIR）。

**Step 2: Commit**

```bash
git commit -m "feat: add reviewAgent definition with workspace support"
```

---

### Task 19: Review Execution Step

**Files:**
- Create: `src/mastra/workflows/steps/reviewExecutionStep.ts`
- Test: `src/mastra/workflows/steps/__tests__/reviewExecutionStep.test.ts`

**Step 1: Write the failing test**

テストケース:
1. グループ内の全チェック項目のレビュー結果が返される
2. Agent実行後に漏れがあった場合、再度Agentに指示される
3. Agentがエラーの場合、エラー結果が返される

Agent呼び出しはモックする。

**Step 2-5: Implement, test, commit**

```bash
git commit -m "feat: add reviewExecutionStep with retry for missing results"
```

---

### Task 20: Review Workflow

WorkflowでStep 1とStep 2を組み立てる。

**Files:**
- Create: `src/mastra/workflows/reviewWorkflow.ts`
- Create: `src/mastra/workflows/index.ts`

**Step 1: Write workflow definition**

Mastra Workflow構成（embedded docsの `docs-workflows-overview.md` と `reference-workflows-workflow-methods-foreach.md` を参照）:
1. `then`: checklistSplitStep
2. `foreach`: reviewExecutionStep（並列度5）

入力スキーマ（Zod）:
- checklist items
- concurrentReviewCount
- reviewSettings
- mrContext
- priorReviewContext（optional）
- userId, aiApiKey, aiApiEndpointUrl, aiModelName
- skillsPaths

出力: `ReviewResult[]`

**Step 2: Commit**

```bash
git commit -m "feat: add reviewWorkflow combining split and execution steps"
```

---

### Task 21: Update Mastra Index

**Files:**
- Modify: `src/mastra/index.ts`

**Step 1: Remove weather samples and register new components**

- weatherAgent, weatherWorkflow, weather scorersのimportを削除
- reviewWorkflowを登録
- 対応するweatherファイル群を削除:
  - `src/mastra/agents/weather-agent.ts`
  - `src/mastra/tools/weather-tool.ts`
  - `src/mastra/workflows/weather-workflow.ts`
  - `src/mastra/scorers/weather-scorer.ts`

**Step 2: Commit**

```bash
git commit -m "feat: register review workflow and remove weather samples"
```

---

## Phase 5: Application Service & Presentation

### Task 22: ExecuteReviewService

メインのユースケースオーケストレーション。

**Files:**
- Create: `src/application/executeReview/ExecuteReviewService.ts`
- Test: `src/application/executeReview/__tests__/ExecuteReviewService.test.ts`

**Step 1: Write the failing test**

Gateway、Workflow実行をモックしてテスト。

テストケース:
1. 正常系: 事前処理→Workflow実行→コメント投稿の全フローが実行される
2. 過去のチェック結果が存在する場合、PriorReviewContextが生成される
3. 過去のチェック結果が存在しない場合、PriorReviewContextはnull
4. 過去のチェック結果のうち、今回のチェックリストに含まれない項目は除外される
5. コメント投稿が成功する
6. エラー時に適切なエラーがスローされる

**Step 2: Run tests to verify they fail**

**Step 3: Write implementation**

```typescript
// src/application/executeReview/ExecuteReviewService.ts
export class ExecuteReviewService {
  constructor(
    private readonly mrGateway: MrGateway,
    private readonly mrCommentGateway: MrCommentGateway,
    private readonly commentFormatter: CommentFormatter,
    private readonly commentParser: CommentParser,
    private readonly workflowRunner: ReviewWorkflowRunner,
  ) {}

  async execute(command: ExecuteReviewCommand): Promise<ExecuteReviewDto> {
    // Step 0: 事前処理
    // Step 1-2: Workflow実行
    // Step 3: コメント投稿
  }
}
```

WorkflowRunnerはインターフェースとして抽象化し、Mastra Workflowの実行をラップする。

**Step 4-5: Test, commit**

```bash
git commit -m "feat: add ExecuteReviewService orchestrating full review flow"
```

---

### Task 23: Update CLI and Environment Variables

**Files:**
- Modify: `src/lib/cli.ts` - `GITLAB_API_TOKEN` → `GITLAB_TOKEN`、`AI_MODEL_NAME` 追加
- Modify: `src/lib/__tests__/cli.test.ts` - テスト更新
- Modify: `.env.example`
- Modify: `.ci-template/variable/variables.yml`
- Modify: `docs/config/env_val.md`

**Step 1: Update cli.ts**

CliOptionsに追加:
- `aiModelName: string` (default: `'openai/o4-mini'`)

環境変数マッピング変更:
- `GITLAB_API_TOKEN` → `GITLAB_TOKEN`
- 新規: `AI_MODEL_NAME`

**Step 2: Update tests**

既存テストの `GITLAB_API_TOKEN` 参照を `GITLAB_TOKEN` に変更。
`AI_MODEL_NAME` のテストケース追加。

**Step 3: Update config files**

`.env.example`:
- `GITLAB_API_TOKEN` → `GITLAB_TOKEN`
- `AI_MODEL_NAME=openai/o4-mini` 追加

`.ci-template/variable/variables.yml`:
- `GITLAB_API_TOKEN` → `GITLAB_TOKEN`
- `AI_MODEL_NAME: "openai/o4-mini"` 追加

`docs/config/env_val.md`:
- テーブル内の `GITLAB_API_TOKEN` → `GITLAB_TOKEN`
- `AI_MODEL_NAME` 行追加

**Step 4: Run all tests**

Run: `npm run test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git commit -m "feat: rename GITLAB_API_TOKEN to GITLAB_TOKEN and add AI_MODEL_NAME"
```

---

### Task 24: Update Entry Point

**Files:**
- Modify: `src/index.ts`

**Step 1: Write the full entry point**

```typescript
// src/index.ts
import { parseCliOptions } from './lib/cli.js';
import { initializeLogger, getLogger } from './lib/logger.js';
import { ChecklistParser } from './application/shared/parser/index.js';
import { ReviewSettingsParser } from './application/shared/parser/index.js';
import { ExecuteReviewService } from './application/executeReview/ExecuteReviewService.js';
import { GitLabApiClient } from './infrastructure/adapter/httpClient/index.js';
import { GitLabMrGateway } from './infrastructure/adapter/gateway/index.js';
import { GitLabMrCommentGateway } from './infrastructure/adapter/gateway/index.js';
import { CommentFormatter } from './application/shared/comment/index.js';
import { CommentParser } from './application/shared/comment/index.js';
import fs from 'node:fs';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2), process.env as Record<string, string>);

  initializeLogger({
    userId: options.userId ?? 'unknown',
    level: options.logLevel,
  });

  const logger = getLogger();
  logger.info('aikata-pr started');

  try {
    // 入力ファイル読み込み
    const checklistCsv = fs.readFileSync(options.checklist!, 'utf-8');
    const checklist = ChecklistParser.parse(checklistCsv);

    const reviewSettings = options.reviewSettings
      ? ReviewSettingsParser.parse(fs.readFileSync(options.reviewSettings, 'utf-8'))
      : ReviewSettingsParser.default();

    const skillsPaths = options.skills ? [options.skills] : [];

    // DI組み立て
    const gitlabClient = new GitLabApiClient(
      process.env['AI_API_ENDPOINT_URL']!, // GitLab APIのベースURLは別途検討
      options.gitlabToken!,
    );
    const mrGateway = new GitLabMrGateway(gitlabClient);
    const mrCommentGateway = new GitLabMrCommentGateway(gitlabClient);
    const commentFormatter = new CommentFormatter();
    const commentParser = new CommentParser();
    // WorkflowRunnerの組み立ては実装時に詳細化

    const service = new ExecuteReviewService(
      mrGateway,
      mrCommentGateway,
      commentFormatter,
      commentParser,
      workflowRunner,
    );

    const result = await service.execute({
      userId: options.userId!,
      projectId: options.projectId!,
      mrIid: options.mrIid!,
      checklist,
      reviewSettings,
      skillsPaths,
      aiApiKey: process.env['AI_API_KEY']!,
      aiApiEndpointUrl: process.env['AI_API_ENDPOINT_URL']!,
      aiModelName: options.aiModelName,
      gitlabToken: options.gitlabToken!,
    });

    logger.info({ resultCount: result.results.length, commentPosted: result.commentPosted }, 'Review completed');
  } catch (error) {
    const userId = options.userId ?? 'unknown';
    if (options.verboseError && error instanceof Error) {
      logger.error({ err: error, userId }, 'Review failed');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ userId }, `Review failed: ${message}`);
    }
    process.exit(1);
  }
}

main();
```

**Step 2: Commit**

```bash
git commit -m "feat: update entry point to wire full review flow"
```

---

### Task 25: Update Domain Documentation

**Files:**
- Modify: `docs/domain/entity.md`
- Modify: `docs/domain/business_rule.md`
- Modify: `docs/domain/usecase.md`

設計ドキュメントのドメイン定義に基づいて、テンプレートファイルにエンティティ・ビジネスルール・ユースケースを記載する。

**Step 1: Write documentation**

**Step 2: Commit**

```bash
git commit -m "docs: update domain documentation with entities and business rules"
```

---

### Task 26: Final Verification

**Step 1: Run all tests**

Run: `npm run test`
Expected: ALL PASS

**Step 2: Run coverage check**

Run: `npm run test:coverage`
Expected: Branch coverage >= 80%

**Step 3: Run lint**

Run: `npm run lint`
Expected: No errors (formatting errors are acceptable)

**Step 4: Run build**

Run: `npm run build:cli`
Expected: `dist/index.js` generated without errors

**Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: No new type errors

**Step 6: Commit any remaining fixes**

```bash
git commit -m "fix: address lint/type/coverage issues"
```
