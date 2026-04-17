import { describe, it, expect } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { RequestContext } from '@mastra/core/request-context';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import {
  createWorkspaceFromContext,
  buildInstructions,
  buildUserPrompt,
  buildPrepareStepForImageInjection,
} from '../reviewAgent.js';
import type { ReviewAgentRequestContext } from '../../requestContext.js';
import { PENDING_IMAGES_KEY } from '../../tools/readImage.js';

/**
 * テスト用のReviewAgentRequestContextを生成するヘルパー
 */
function createTestContext(
  overrides?: Partial<ReviewAgentRequestContext>,
): ReviewAgentRequestContext {
  return {
    userId: 'test-user',
    projectId: 'test-project',
    aiApiKey: 'test-key',
    aiApiEndpointUrl: 'http://localhost',
    aiModelName: 'test-model',
    projectDir: '/test/project',
    checkItems: [],
    ratings: [],
    commentFormat: '',
    additionalInstructions: '',
    resultFilePath: '/tmp/test-results.json',
    commentLanguage: 'Japanese',
    mrTitle: '',
    mrDescription: '',
    mrSourceBranch: '',
    mrTargetBranch: '',
    mrDiff: '',
    priorReviewContext: null,
    skillsPaths: [],
    folderTree: '',
    pendingImages: [],
    openaiReasoningEffort: undefined,
    omittedFileDiffs: null,
    allDiffFilePaths: null,
    diffCompressed: false,
    folderTreeRemovedByCompression: false,
    ...overrides,
  };
}

/**
 * テスト用のRequestContextを生成するヘルパー
 */
function createTestRequestContext(
  overrides?: Partial<ReviewAgentRequestContext>,
): RequestContext<ReviewAgentRequestContext> {
  const ctx = createTestContext(overrides);
  return new RequestContext<ReviewAgentRequestContext>([
    ['userId', ctx.userId],
    ['projectId', 'test-project'],
    ['aiApiKey', ctx.aiApiKey],
    ['aiApiEndpointUrl', ctx.aiApiEndpointUrl],
    ['aiModelName', ctx.aiModelName],
    ['projectDir', ctx.projectDir],
    ['checkItems', ctx.checkItems],
    ['ratings', ctx.ratings],
    ['commentFormat', ctx.commentFormat],
    ['additionalInstructions', ctx.additionalInstructions],
    ['resultFilePath', ctx.resultFilePath],
    ['commentLanguage', ctx.commentLanguage],
    ['mrTitle', ctx.mrTitle],
    ['mrDescription', ctx.mrDescription],
    ['mrSourceBranch', ctx.mrSourceBranch],
    ['mrTargetBranch', ctx.mrTargetBranch],
    ['mrDiff', ctx.mrDiff],
    ['priorReviewContext', ctx.priorReviewContext],
    ['skillsPaths', ctx.skillsPaths],
    ['folderTree', ctx.folderTree],
    ['pendingImages', ctx.pendingImages],
    ['openaiReasoningEffort', ctx.openaiReasoningEffort],
    ['omittedFileDiffs', ctx.omittedFileDiffs],
    ['allDiffFilePaths', ctx.allDiffFilePaths],
    ['diffCompressed', ctx.diffCompressed],
    ['folderTreeRemovedByCompression', ctx.folderTreeRemovedByCompression],
  ]);
}

describe('buildInstructions', () => {
  it('チェック項目がsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      checkItems: [
        { id: 1, content: 'security check' },
        { id: 2, content: 'performance check' },
      ],
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('[ID: 1]\nsecurity check');
    expect(result).toContain('[ID: 2]\nperformance check');
  });

  it('チェック項目の構造化フォーマット説明がsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      checkItems: [
        {
          id: 1,
          content:
            'カテゴリ:\n---\nセキュリティ\n---\n\nチェック項目:\n---\nSQLインジェクション対策\n---',
        },
      ],
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('structured multi-column format');
    expect(result).toContain('<header>:');
    expect(result).toContain('<value>');
    expect(result).toContain('plain text');
  });

  it('評定基準がsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      ratings: [
        { label: 'A', definition: 'Fully satisfies requirements' },
        { label: 'C', definition: 'Does not satisfy requirements' },
      ],
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('A: Fully satisfies requirements');
    expect(result).toContain('C: Does not satisfy requirements');
  });

  it('コメントフォーマットがsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      commentFormat: '## Review\n{comment}',
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('## Review\n{comment}');
  });

  it('ReActフレームワーク（REASON, ACT, OBSERVE）が含まれる', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    expect(result).toContain('REASON');
    expect(result).toContain('ACT');
    expect(result).toContain('OBSERVE');
    expect(result).toMatch(/Reasoning Framework.*ReAct/);
  });

  it('ツールリファレンスが含まれる', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    expect(result).toContain('storeReviewResult');
    expect(result).toContain('getReviewResults');
    expect(result).toContain('No arguments needed');
    expect(result).toMatch(/Workspace/i);
  });

  it('冒頭文で入力物としてプロジェクトフォルダツリーが明示される', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    // ユーザから渡される入力物の列挙にフォルダツリーが含まれていること
    expect(result).toMatch(/You will receive[^.]*folder tree/i);
  });

  it('Workspace Toolsセクションでフォルダツリーをリポジトリの地図として言及する', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    // Workspace Tools セクション内にフォルダツリーへの参照と地図としての位置付けがある
    const workspaceSectionIndex = result.indexOf('### Workspace Tools');
    expect(workspaceSectionIndex).toBeGreaterThanOrEqual(0);
    const workspaceSection = result.slice(workspaceSectionIndex);
    expect(workspaceSection).toMatch(/folder tree/i);
    expect(workspaceSection).toMatch(/map/i);
  });

  it('完了要件が含まれる', () => {
    const requestContext = createTestRequestContext();

    const result = buildInstructions(requestContext);

    expect(result).toMatch(/MUST review/i);
    expect(result).toMatch(/Do NOT finish/i);
  });

  it('MR情報（title, description, branches, diff）がsystemプロンプトに含まれない', () => {
    const requestContext = createTestRequestContext({
      mrTitle: 'UNIQUE_MR_TITLE',
      mrDescription: 'UNIQUE_MR_DESCRIPTION',
      mrSourceBranch: 'feature/unique-branch',
      mrTargetBranch: 'main-unique-target',
      mrDiff: 'UNIQUE_DIFF_CONTENT_HERE',
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('UNIQUE_MR_TITLE');
    expect(result).not.toContain('UNIQUE_MR_DESCRIPTION');
    expect(result).not.toContain('feature/unique-branch');
    expect(result).not.toContain('main-unique-target');
    expect(result).not.toContain('UNIQUE_DIFF_CONTENT_HERE');
  });

  it('過去のチェック結果がsystemプロンプトに含まれない', () => {
    const requestContext = createTestRequestContext({
      priorReviewContext: {
        results: [
          { checkItemContent: 'check1', ratingLabel: 'B', comment: 'UNIQUE_PRIOR_COMMENT' },
        ],
        commitMessages: ['UNIQUE_PRIOR_COMMIT'],
        diffSincePrior: 'UNIQUE_PRIOR_DIFF',
      },
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('UNIQUE_PRIOR_COMMENT');
    expect(result).not.toContain('UNIQUE_PRIOR_COMMIT');
    expect(result).not.toContain('UNIQUE_PRIOR_DIFF');
  });

  it('additionalInstructionsが非空の場合、Additional Instructionsセクションが含まれる', () => {
    const requestContext = createTestRequestContext({
      additionalInstructions: 'Focus on security vulnerabilities',
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('User-Specified Review Instructions (HIGHEST PRIORITY)');
    expect(result).toContain('You MUST follow these instructions with the highest priority');
    expect(result).toContain('Focus on security vulnerabilities');
  });

  it('commentLanguageで指定された言語がsystemプロンプトに含まれる', () => {
    const requestContext = createTestRequestContext({
      commentLanguage: 'English',
    });

    const result = buildInstructions(requestContext);

    // 冒頭の言語指示: 思考は英語、コメントのみ指定言語
    expect(result).toContain('Always reason and think in English');
    expect(result).toContain('you MUST write them in English');
    // storeReviewResultの説明にもコメント言語の指示が含まれる
    expect(result).toContain('comment (MUST be written in English)');
  });

  it('デフォルト(Japanese)の場合もsystemプロンプトに言語指定が含まれる', () => {
    const requestContext = createTestRequestContext({
      commentLanguage: 'Japanese',
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('you MUST write them in Japanese');
    expect(result).toContain('comment (MUST be written in Japanese)');
  });

  it('additionalInstructionsが空の場合、Additional Instructionsセクションが含まれない', () => {
    const requestContext = createTestRequestContext({
      additionalInstructions: '',
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('User-Specified Review Instructions (HIGHEST PRIORITY)');
  });

  it('folderTreeに画像ファイルが含まれる場合、readImageツールの説明が含まれる', () => {
    const requestContext = createTestRequestContext({
      folderTree: 'src/\n  assets/\n    logo.png\n  index.ts',
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('readImage');
    expect(result).toContain('PNG, JPEG, GIF, WebP');
    expect(result).toContain('MUST use this tool');
  });

  it('folderTreeに画像ファイルが含まれない場合、readImageツールの説明が含まれない', () => {
    const requestContext = createTestRequestContext({
      folderTree: 'src/\n  index.ts\n  utils/\n    helper.ts',
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('readImage');
    expect(result).not.toContain('Image Reading Tool');
  });

  it('folderTreeRemovedByCompression=trueの場合、Folder Tree Noticeが含まれる', () => {
    const requestContext = createTestRequestContext({
      folderTreeRemovedByCompression: true,
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('Folder Tree Notice');
    expect(result).toContain('mastra_workspace_list_files');
  });

  it('folderTreeRemovedByCompression=falseの場合、Folder Tree Noticeが含まれない', () => {
    const requestContext = createTestRequestContext({
      folderTreeRemovedByCompression: false,
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('Folder Tree Notice');
  });

  it('diffCompressed=trueの場合、Diff Compression Noticeが含まれる', () => {
    const requestContext = createTestRequestContext({
      diffCompressed: true,
    });

    const result = buildInstructions(requestContext);

    expect(result).toContain('Diff Compression Notice');
    expect(result).toContain('getDiffDetail');
  });

  it('diffCompressed=falseの場合、Diff Compression Noticeが含まれない', () => {
    const requestContext = createTestRequestContext({
      diffCompressed: false,
    });

    const result = buildInstructions(requestContext);

    expect(result).not.toContain('Diff Compression Notice');
  });
});

describe('buildUserPrompt', () => {
  it('RequestContextからbuildUserPromptTemplateへ正しく委譲される', () => {
    const requestContext = createTestRequestContext({
      mrTitle: 'Add login feature',
      mrDescription: 'Implements OAuth2 login',
      mrSourceBranch: 'feature/login',
      mrTargetBranch: 'main',
      mrDiff: '+ added new line',
      folderTree: 'src/\n  index.ts',
      checkItems: [
        { id: 1, content: 'item1' },
        { id: 2, content: 'item2' },
      ],
    });

    const result = buildUserPrompt(requestContext);

    // MR情報が含まれる
    expect(result).toContain('Add login feature');
    expect(result).toContain('Implements OAuth2 login');
    // diffが含まれる
    expect(result).toContain('+ added new line');
    // フォルダツリーが含まれる
    expect(result).toContain('Project Folder Tree');
    // チェック項目数が含まれる
    expect(result).toContain('Review all 2 check items');
  });

  it('resultFilePathがuserプロンプトに含まれない', () => {
    const requestContext = createTestRequestContext({
      resultFilePath: '/tmp/test-results.json',
    });

    const result = buildUserPrompt(requestContext);

    expect(result).not.toContain('/tmp/test-results.json');
  });
});

describe('buildPrepareStepForImageInjection', () => {
  /**
   * テスト用にProcessInputStepArgsの最小限のモックを作成するヘルパー
   * buildPrepareStepForImageInjectionはmessagesのみ使用する
   */
  function createMockArgs(messages: MastraDBMessage[] = []): ProcessInputStepArgs {
    return { messages } as ProcessInputStepArgs;
  }

  it('pendingImagesが空の場合、undefinedを返す（メッセージ変更なし）', () => {
    const requestContext = createTestRequestContext();
    const prepareStep = buildPrepareStepForImageInjection(requestContext);

    const result = prepareStep(createMockArgs());

    expect(result).toBeUndefined();
  });

  it('pendingImagesがある場合、画像付きuserメッセージが末尾に追加される', () => {
    const requestContext = createTestRequestContext();
    requestContext.set(PENDING_IMAGES_KEY, [
      { filePath: 'assets/logo.png', base64Data: 'iVBORw0KGgo=', mediaType: 'image/png' },
    ]);

    const prepareStep = buildPrepareStepForImageInjection(requestContext);
    const existingMessage = {
      id: 'msg-1',
      role: 'user',
      createdAt: new Date(),
      content: { format: 2, parts: [{ type: 'text', text: 'original' }] },
    } as MastraDBMessage;
    const result = prepareStep(createMockArgs([existingMessage]));

    // messagesが返される
    expect(result).toHaveProperty('messages');
    const messages = result!.messages!;
    // 元のメッセージ + 新しいuserメッセージ
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(existingMessage);

    // 新しいuserメッセージの構造を検証（MastraDBMessage形式）
    const imageMessage = messages[1];
    expect(imageMessage.role).toBe('user');
    expect(imageMessage.id).toBeDefined();
    expect(imageMessage.createdAt).toBeInstanceOf(Date);
    expect(imageMessage.content.format).toBe(2);

    // テキストパート
    const textPart = imageMessage.content.parts[0];
    expect(textPart.type).toBe('text');
    expect((textPart as { text: string }).text).toContain(
      'The readImage tool was used to retrieve',
    );
    expect((textPart as { text: string }).text).toContain('1 image(s)');
    expect((textPart as { text: string }).text).toContain('assets/logo.png');
    expect((textPart as { text: string }).text).toContain('Please continue your analysis');

    // ファイルパート（v4 FileUIPart形式）
    const filePart = imageMessage.content.parts[1] as {
      type: string;
      mimeType: string;
      data: string;
    };
    expect(filePart.type).toBe('file');
    expect(filePart.data).toBe('iVBORw0KGgo=');
    expect(filePart.mimeType).toBe('image/png');
  });

  it('複数のpendingImagesがある場合、全画像が1つのuserメッセージに含まれる', () => {
    const requestContext = createTestRequestContext();
    requestContext.set(PENDING_IMAGES_KEY, [
      { filePath: 'a.png', base64Data: 'data1', mediaType: 'image/png' },
      { filePath: 'b.jpg', base64Data: 'data2', mediaType: 'image/jpeg' },
    ]);

    const prepareStep = buildPrepareStepForImageInjection(requestContext);
    const result = prepareStep(createMockArgs());

    const messages = result!.messages!;
    expect(messages).toHaveLength(1);

    const imageMessage = messages[0];
    expect(imageMessage.content.parts).toHaveLength(3); // 1 text + 2 files

    // テキストにファイルパスリストが含まれる
    const textPart = imageMessage.content.parts[0] as { text: string };
    expect(textPart.text).toContain('2 image(s)');
    expect(textPart.text).toContain('1. a.png');
    expect(textPart.text).toContain('2. b.jpg');

    // ファイルパート
    const filePart1 = imageMessage.content.parts[1] as { type: string; mimeType: string };
    const filePart2 = imageMessage.content.parts[2] as { type: string; mimeType: string };
    expect(filePart1.type).toBe('file');
    expect(filePart1.mimeType).toBe('image/png');
    expect(filePart2.type).toBe('file');
    expect(filePart2.mimeType).toBe('image/jpeg');
  });

  it('注入後にpendingImagesがクリアされる', () => {
    const requestContext = createTestRequestContext();
    requestContext.set(PENDING_IMAGES_KEY, [
      { filePath: 'a.png', base64Data: 'data1', mediaType: 'image/png' },
    ]);

    const prepareStep = buildPrepareStepForImageInjection(requestContext);
    prepareStep(createMockArgs());

    // pendingImagesがクリアされている
    const pendingImages = requestContext.get(PENDING_IMAGES_KEY);
    expect(pendingImages).toHaveLength(0);
  });

  it('2回目の呼び出しではpendingImagesが空のためundefinedを返す', () => {
    const requestContext = createTestRequestContext();
    requestContext.set(PENDING_IMAGES_KEY, [
      { filePath: 'a.png', base64Data: 'data1', mediaType: 'image/png' },
    ]);

    const prepareStep = buildPrepareStepForImageInjection(requestContext);

    // 1回目: 画像注入
    const result1 = prepareStep(createMockArgs());
    expect(result1).toHaveProperty('messages');

    // 2回目: pendingImagesが空のため変更なし
    const result2 = prepareStep(createMockArgs());
    expect(result2).toBeUndefined();
  });
});

describe('createWorkspaceFromContext', () => {
  it('Workspaceインスタンスを生成する', () => {
    const ctx = createTestContext({ projectDir: '/my/project' });
    const workspace = createWorkspaceFromContext(ctx);
    expect(workspace).toBeInstanceOf(Workspace);
  });

  it('skillsPathsが空の場合、skillsはundefinedになる', () => {
    const ctx = createTestContext({ skillsPaths: [] });
    const workspace = createWorkspaceFromContext(ctx);
    // Workspaceのskillsプロパティはskillsが未設定の場合undefined
    expect(workspace.skills).toBeUndefined();
  });

  it('skillsPathsが指定されている場合、skillsが設定される', () => {
    const ctx = createTestContext({ skillsPaths: ['/path/to/skills'] });
    const workspace = createWorkspaceFromContext(ctx);
    // skillsが設定されている場合、WorkspaceSkillsインスタンスが存在する
    expect(workspace.skills).toBeDefined();
  });

  it('WORKSPACE_TOOLS_CONFIGがWorkspaceに設定される', () => {
    const ctx = createTestContext({ projectDir: '/my/project' });
    const workspace = createWorkspaceFromContext(ctx);
    const toolsConfig = workspace.getToolsConfig();
    expect(toolsConfig).toBeDefined();
    expect(toolsConfig?.mastra_workspace_read_file?.maxOutputTokens).toBe(6000);
    expect(toolsConfig?.mastra_workspace_grep?.maxOutputTokens).toBe(6000);
    expect(toolsConfig?.mastra_workspace_list_files?.maxOutputTokens).toBe(2000);
    expect(toolsConfig?.mastra_workspace_execute_command?.maxOutputTokens).toBe(4000);
  });
});
