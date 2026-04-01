import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { LocalProjectTreeGateway } from '../LocalProjectTreeGateway.js';

/**
 * テスト用の一時ディレクトリを作成するヘルパー
 */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aikata-tree-test-'));
}

/**
 * ディレクトリ構造を一括作成するヘルパー
 * パスが '/' で終わる場合はディレクトリ、それ以外はファイルとして作成
 */
function createStructure(baseDir: string, paths: string[]): void {
  for (const p of paths) {
    const fullPath = path.join(baseDir, p);
    if (p.endsWith('/')) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, '');
    }
  }
}

/**
 * 一時ディレクトリにgitリポジトリを初期化するヘルパー
 */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
}

/**
 * デフォルトのツリーオプション（深さ制限なし）
 */
const defaultOptions = { maxDepth: undefined };

// テスト後にクリーンアップする一時ディレクトリを管理
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('LocalProjectTreeGateway', () => {
  it('シンプルなディレクトリ構造で正しいツリーが生成される', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    createStructure(tmpDir, ['src/index.ts', 'src/lib/utils.ts', 'README.md']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    expect(tree).toContain('src/');
    expect(tree).toContain('index.ts');
    expect(tree).toContain('lib/');
    expect(tree).toContain('utils.ts');
    expect(tree).toContain('README.md');
  });

  it('.gitignoreに記載されたファイル・ディレクトリが除外される', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);

    // .gitignoreを作成
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\ndist\n*.log\ncoverage/\n');

    createStructure(tmpDir, [
      'src/index.ts',
      'node_modules/package/index.js',
      'dist/bundle.js',
      'coverage/report.html',
      'debug.log',
      'app.log',
    ]);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    // .gitignoreに含まれるものは除外される
    expect(tree).toContain('src/');
    expect(tree).toContain('index.ts');
    expect(tree).toContain('.gitignore');
    expect(tree).not.toContain('node_modules');
    expect(tree).not.toContain('dist');
    expect(tree).not.toContain('coverage');
    expect(tree).not.toContain('debug.log');
    expect(tree).not.toContain('app.log');
  });

  it('.gitディレクトリが除外される', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    createStructure(tmpDir, ['src/index.ts']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    expect(tree).toContain('src/');
    expect(tree).not.toContain('.git/');
  });

  it('ディレクトリがファイルより先にソートされる（各アルファベット順）', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    createStructure(tmpDir, ['z-file.txt', 'a-file.txt', 'b-dir/child.txt', 'a-dir/child.txt']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    const lines = tree.split('\n').filter((l) => l.trim());
    // ディレクトリが先に来る
    const aDirIndex = lines.findIndex((l) => l.includes('a-dir/'));
    const bDirIndex = lines.findIndex((l) => l.includes('b-dir/'));
    const aFileIndex = lines.findIndex((l) => l.includes('a-file.txt'));
    const zFileIndex = lines.findIndex((l) => l.includes('z-file.txt'));

    // ディレクトリ同士はアルファベット順
    expect(aDirIndex).toBeLessThan(bDirIndex);
    // ディレクトリはファイルより先
    expect(bDirIndex).toBeLessThan(aFileIndex);
    // ファイル同士はアルファベット順
    expect(aFileIndex).toBeLessThan(zFileIndex);
  });

  it('深さ制限が指定された場合に制限される', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    createStructure(tmpDir, ['level1/level2/level3/deep.txt', 'level1/shallow.txt']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, { maxDepth: 2 });

    expect(tree).toContain('level1/');
    expect(tree).toContain('level2/');
    expect(tree).toContain('shallow.txt');
    // 深さ2まで（level1=1, level2=2）なのでlevel3以下は含まれない
    expect(tree).not.toContain('level3');
    expect(tree).not.toContain('deep.txt');
  });

  it('深さ制限が未指定の場合は無制限に走査される', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    createStructure(tmpDir, ['a/b/c/d/e/f/g/h/i/j/k/deep.txt']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, { maxDepth: undefined });

    expect(tree).toContain('deep.txt');
  });

  it('エントリ数上限を超えた場合はディレクトリのみのツリーが返る', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    // ディレクトリ+ファイルを含む構造（合計8エントリ以上）
    createStructure(tmpDir, [
      'src/index.ts',
      'src/lib/utils.ts',
      'src/lib/helpers.ts',
      'tests/test1.ts',
      'tests/test2.ts',
      'docs/readme.md',
      'config.json',
      'package.json',
    ]);

    const gateway = new LocalProjectTreeGateway({ maxEntries: 5 });
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    // ディレクトリのみが含まれる
    const lines = tree.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      expect(line.trimStart()).toMatch(/\/$/);
    }
    expect(tree).toContain('src/');
    expect(tree).toContain('lib/');
    expect(tree).toContain('tests/');
    expect(tree).toContain('docs/');
    // ファイルは含まれない
    expect(tree).not.toContain('index.ts');
    expect(tree).not.toContain('config.json');
    // truncatedメッセージも含まれない
    expect(tree).not.toContain('truncated');
  });

  it('gitリポジトリでない場合は.gitのみ除外してフォールバックする', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    // git initしない
    createStructure(tmpDir, ['src/index.ts', '.git/config', 'node_modules/package/index.js']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    // .gitのみ除外される
    expect(tree).toContain('src/');
    expect(tree).toContain('index.ts');
    expect(tree).not.toContain('.git');
    // フォールバック時は.gitignoreベースの除外は適用されない
    expect(tree).toContain('node_modules');
  });

  it('非ASCII文字（日本語）を含むファイル名が正しくツリーに表示される', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    createStructure(tmpDir, ['images/受験票_1-048_combined.png', 'src/index.ts']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    // 非ASCIIファイル名がクリーンなUTF-8で表示されること
    expect(tree).toContain('受験票_1-048_combined.png');
    expect(tree).toContain('images/');
    expect(tree).toContain('index.ts');
    // gitのoctalエスケープやダブルクォートが含まれないこと
    expect(tree).not.toContain('\\345');
    expect(tree).not.toContain('"images');
  });

  it('非ASCII文字を含む画像ファイル名がcontainsImageFilesで検出される', async () => {
    const tmpDir = createTempDir();
    tempDirs.push(tmpDir);
    initGitRepo(tmpDir);
    createStructure(tmpDir, ['images/受験票_1-048_combined.png', 'src/index.ts']);

    const gateway = new LocalProjectTreeGateway();
    const tree = await gateway.getTree(tmpDir, defaultOptions);

    const { containsImageFiles } = await import('../../../../lib/imageFormat.js');
    expect(containsImageFiles(tree)).toBe(true);
  });

  it('存在しないディレクトリでエラーがスローされる', async () => {
    const gateway = new LocalProjectTreeGateway();

    await expect(gateway.getTree('/nonexistent/path/12345', defaultOptions)).rejects.toThrow();
  });
});
