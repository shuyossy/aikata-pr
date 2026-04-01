import { randomUUID } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { ProcessInputStepArgs, ProcessInputStepResult } from '@mastra/core/processors';
import { Workspace, LocalFilesystem, LocalSandbox } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';
import type { ReviewAgentRequestContext } from '../requestContext.js';
import { createModelFromContext } from '../requestContext.js';
import { storeReviewResultTool } from '../tools/storeReviewResult.js';
import { getReviewResultsTool } from '../tools/getReviewResults.js';
import { readImageTool, PENDING_IMAGES_KEY, IMAGE_MESSAGE_PREFIX } from '../tools/readImage.js';
import { getDiffDetailTool } from '../tools/getDiffDetail.js';
import { containsImageFiles } from '../../lib/imageFormat.js';
import { buildUserPromptTemplate } from '../../application/shared/prompt/index.js';

// レビューエージェントのツールセット型（readImage, getDiffDetailは条件付き登録）
type ReviewAgentToolSet = {
  storeReviewResult: typeof storeReviewResultTool;
  getReviewResults: typeof getReviewResultsTool;
  readImage?: typeof readImageTool;
  getDiffDetail?: typeof getDiffDetailTool;
};

// 基本ツール（常に登録）
const baseReviewAgentTools: ReviewAgentToolSet = {
  storeReviewResult: storeReviewResultTool,
  getReviewResults: getReviewResultsTool,
};

// 画像対応ツール（画像ファイルがある場合のみ登録）
const reviewAgentToolsWithImage: ReviewAgentToolSet = {
  ...baseReviewAgentTools,
  readImage: readImageTool,
};

// diff圧縮対応ツール（diff圧縮が有効な場合のみ登録）
const reviewAgentToolsWithDiffDetail: ReviewAgentToolSet = {
  ...baseReviewAgentTools,
  getDiffDetail: getDiffDetailTool,
};

// 画像 + diff圧縮対応ツール
const reviewAgentToolsWithImageAndDiffDetail: ReviewAgentToolSet = {
  ...baseReviewAgentTools,
  readImage: readImageTool,
  getDiffDetail: getDiffDetailTool,
};

/**
 * RequestContextからレビューエージェントのsystemプロンプト（instructions）を組み立てる
 *
 * レビュー方針、ReAct推論フレームワーク、チェック項目、評定基準、ツールガイダンスを含む。
 * MR情報やdiff、過去チェック結果はuserプロンプト（buildUserPrompt）側に配置する。
 */
export function buildInstructions(
  requestContext: RequestContext<ReviewAgentRequestContext>,
): string {
  const ctx = requestContext.all;

  const ratingsText = ctx.ratings.map((r) => `- ${r.label}: ${r.definition}`).join('\n');
  const checkItemsText = ctx.checkItems
    .map((item) => `[ID: ${item.id}] ${item.content}`)
    .join('\n');

  const additionalInstructionsSection = ctx.additionalInstructions
    ? `## User-Specified Review Instructions (HIGHEST PRIORITY)\n\nThe following instructions were provided by the user as review requirements. You MUST follow these instructions with the highest priority.\n\n${ctx.additionalInstructions}\n\n`
    : '';

  return `You are an expert MR (Merge Request) code review specialist. You will receive an MR diff and a set of check items. Your job is to evaluate each check item against the MR and provide a rating and comment.

Always reason and think in English. When writing review comments, you MUST write them in ${ctx.commentLanguage}.

## Reasoning Framework (ReAct)

For each check item, apply the Reason-Act-Observe cycle.

Repeat the following until you can confidently rate the check item:

**REASON**: Assess your current understanding.
- What does this check item require?
- What evidence do you already have from the diff or prior investigation?
- What is still unknown? Which tool would fill that gap, and why?

**ACT**: Execute your decision.
- If investigation is needed: call a workspace tool. State the reason before each call.
- If you have sufficient evidence: determine the rating, write a comment using the specified format, and call storeReviewResult to record the result.

**OBSERVE**: Evaluate the result of your action.
- If you used a workspace tool: did it answer your question? Does it raise new questions that affect your rating? If insufficient, return to REASON with updated understanding.
- If you stored a review result: move on to the next check item and start a new cycle.

## Efficiency Guidelines

- If prior review results are provided, focus your analysis on what changed since the prior review. Reuse prior conclusions for unchanged aspects.
- When multiple check items relate to the same code area, investigate once and apply findings across all relevant items.
- Most check items can be evaluated from the diff alone. Only investigate when you have genuine uncertainty that affects your rating.

## Check Items to Review

${checkItemsText}

## Rating Criteria

${ratingsText}

## Comment Format

Use the following format for your comments:
${ctx.commentFormat}

You must strictly follow the above format. Do not add any extra sections or headings beyond what is specified.

${additionalInstructionsSection}## Tool Reference

### Review Result Tools
- storeReviewResult: Store a review result for a single check item. Parameters: checkItemId (the number shown in [ID: N]), ratingLabel (one of the rating labels above), comment (MUST be written in ${ctx.commentLanguage}). You MUST call this for EVERY check item listed above.
- getReviewResults: Retrieve stored results to verify completeness. No arguments needed.
${
  containsImageFiles(ctx.folderTree)
    ? `
### Image Reading Tool
- readImage: Read an image file from the project directory and view its contents. You MUST use this tool whenever you need to view or analyze an image file referenced in the diff or project. Supported formats: PNG, JPEG, GIF, WebP.
  - Always use this tool instead of trying to infer image contents from filenames or context.
  - Pass the file path relative to the project root directory.
`
    : ''
}
${
  ctx.folderTreeRemovedByCompression
    ? `### Folder Tree Notice
File entries have been removed from the project folder tree to conserve context space. Only directory structure is shown. Use the mastra_workspace_list_files tool to view files in specific directories.

`
    : ''
}${
    ctx.diffCompressed
      ? `### Diff Compression Notice
Some file diffs have been compressed to fit within context limits. Compressed sections are marked with "[aikata: N lines omitted from middle]". Use the getDiffDetail tool to retrieve the omitted portion:
- getDiffDetail(filePath): Get the entire omitted middle portion of a compressed file diff
- getDiffDetail(filePath, keywords, contextLines): Search for specific patterns within the omitted portion

`
      : ''
  }### Workspace Tools
You have access to workspace tools for investigating the project codebase:
- File reading: Examine source files beyond what the diff shows
- Directory listing: Understand project structure
- File search: Find code patterns across the codebase
- Sandbox commands: Run git commands, grep, or other CLI tools
The workspace root is the project repository root directory.

## Completion Requirements

1. You MUST review and store results for ALL check items listed above.
2. After storing all results, call getReviewResults to verify completeness.
3. Do NOT finish until ALL check items have been reviewed and stored.`;
}

/**
 * RequestContextからレビューエージェントのuserプロンプトを組み立てる
 *
 * MR情報、diff、過去チェック結果を含む。
 * systemプロンプト（buildInstructions）と対になる。
 */
export function buildUserPrompt(requestContext: RequestContext<ReviewAgentRequestContext>): string {
  const ctx = requestContext.all;
  return buildUserPromptTemplate({
    mrTitle: ctx.mrTitle,
    mrDescription: ctx.mrDescription,
    mrSourceBranch: ctx.mrSourceBranch,
    mrTargetBranch: ctx.mrTargetBranch,
    mrDiff: ctx.mrDiff,
    folderTree: ctx.folderTree,
    priorReviewContext: ctx.priorReviewContext,
    checkItemCount: ctx.checkItems.length,
  });
}

/**
 * レビューエージェント用メモリ
 *
 * リトライ時に会話履歴を保持するためのメモリ設定。
 * lastMessages: コンテキストに含めるメッセージ数の上限。
 *
 * 1000に設定する理由:
 * - ワークスペースツールによる大規模コードベースの探索時には多数のツール呼び出しが発生し得る
 * - 1000は実用上十分な上限でありつつ、無制限によるコンテキストウィンドウ溢れを防止する
 * - 各スレッドはexecuteReview()の実行単位で作成・削除される（初回 + リトライ最大2回）
 */
const reviewAgentMemory = new Memory({
  options: {
    lastMessages: 1000,
  },
});

/**
 * RequestContextからWorkspaceを動的に生成するファクトリ
 *
 * プロジェクトディレクトリをbasePath/workingDirectoryとして設定し、
 * ユーザ指定のskillsパスを登録する。
 * filesystemはreadOnlyにすることで、レビュー時の意図しない書き込みを防ぐ。
 */
export function createWorkspaceFromContext(ctx: ReviewAgentRequestContext): Workspace {
  return new Workspace({
    filesystem: new LocalFilesystem({
      basePath: ctx.projectDir,
      readOnly: true,
    }),
    sandbox: new LocalSandbox({
      workingDirectory: ctx.projectDir,
    }),
    skills: ctx.skillsPaths.length > 0 ? ctx.skillsPaths : undefined,
  });
}

/**
 * レビューエージェント（シングルトン）
 *
 * MRのコードをチェック項目ごとにレビューし、評定とコメントを付けるエージェント。
 * モデル、instructions、workspaceはRequestContextから動的に生成される。
 * メモリにより、リトライ時に会話履歴が保持される。
 */
export const reviewAgent = new Agent<
  'review-agent',
  ReviewAgentToolSet,
  undefined,
  ReviewAgentRequestContext
>({
  id: 'review-agent',
  name: 'Review Agent',
  memory: reviewAgentMemory,
  model: ({ requestContext }) => {
    const ctx = requestContext.all as ReviewAgentRequestContext;
    return createModelFromContext(ctx);
  },
  instructions: ({ requestContext }) => {
    return buildInstructions(requestContext);
  },
  tools: ({ requestContext }) => {
    const ctx = requestContext.all as ReviewAgentRequestContext;
    const hasImages = containsImageFiles(ctx.folderTree);
    const hasDiffCompression = ctx.diffCompressed;

    if (hasImages && hasDiffCompression) return reviewAgentToolsWithImageAndDiffDetail;
    if (hasImages) return reviewAgentToolsWithImage;
    if (hasDiffCompression) return reviewAgentToolsWithDiffDetail;
    return baseReviewAgentTools;
  },
  // workspace: ({ requestContext }) => {
  //   const ctx = requestContext?.all as ReviewAgentRequestContext | undefined;
  //   if (!ctx?.projectDir) {
  //     return undefined;
  //   }
  //   return createWorkspaceFromContext(ctx);
  // },
});

/**
 * prepareStep関数を構築する: readImageツールで取得した画像をuserメッセージとして注入する
 *
 * Chat Completions APIではtoolロールのメッセージにマルチモーダルコンテンツを含められないため、
 * prepareStepフックを利用してuserメッセージとして画像を注入する。
 *
 * @param requestContext - ReviewAgent用のRequestContext（pendingImagesの共有に使用）
 * @returns prepareStep関数。pendingImagesがあればuserメッセージとして画像を注入し、なければ変更なし。
 */
export function buildPrepareStepForImageInjection(
  requestContext: RequestContext<ReviewAgentRequestContext>,
): (args: ProcessInputStepArgs) => ProcessInputStepResult | undefined {
  return ({ messages }) => {
    const pendingImages = requestContext.get(PENDING_IMAGES_KEY) ?? [];

    if (pendingImages.length === 0) {
      return undefined;
    }

    // pendingImagesをクリア
    requestContext.set(PENDING_IMAGES_KEY, []);

    // ファイルパスの番号付きリストを構築
    const fileList = pendingImages.map((img, i) => `${i + 1}. ${img.filePath}`).join('\n');

    // MastraDBMessage形式で画像付きuserメッセージを構築
    // 画像はv4 FileUIPart形式（type: 'file', mimeType, data）で格納する
    const imageUserMessage: MastraDBMessage = {
      id: randomUUID(),
      role: 'user',
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          {
            type: 'text' as const,
            text:
              `${IMAGE_MESSAGE_PREFIX} the following ${pendingImages.length} image(s). ` +
              `Each image is displayed in the order listed below. ` +
              `Please continue your review using these images.\n\n` +
              fileList,
          },
          ...pendingImages.map((img) => ({
            type: 'file' as const,
            mimeType: img.mediaType,
            data: img.base64Data,
          })),
        ],
      },
    };

    return { messages: [...messages, imageUserMessage] };
  };
}
