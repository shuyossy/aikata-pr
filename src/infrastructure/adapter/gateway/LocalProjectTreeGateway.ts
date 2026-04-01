import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  ProjectTreeGateway,
  ProjectTreeOptions,
} from '../../../application/shared/port/gateway/index.js';

/**
 * デフォルトのエントリ数上限
 */
const DEFAULT_MAX_ENTRIES = 500;

/**
 * LocalProjectTreeGatewayの設定
 */
export interface LocalProjectTreeGatewayConfig {
  maxEntries: number;
}

/**
 * ツリー構築用の内部ノード
 */
interface TreeNode {
  children: Map<string, TreeNode>;
}

/**
 * ローカルファイルシステムを走査してプロジェクトのフォルダツリーを生成するゲートウェイ
 *
 * gitリポジトリの場合は `git ls-files` を使用し、.gitignoreに基づいてファイルを除外する。
 * gitが利用できない場合は .git のみ除外してファイルシステムを直接走査する。
 */
export class LocalProjectTreeGateway implements ProjectTreeGateway {
  private readonly maxEntries: number;

  constructor(config: LocalProjectTreeGatewayConfig = { maxEntries: DEFAULT_MAX_ENTRIES }) {
    this.maxEntries = config.maxEntries;
  }

  async getTree(projectDir: string, options: ProjectTreeOptions): Promise<string> {
    if (!fs.existsSync(projectDir)) {
      throw new Error(`Directory not found: ${projectDir}`);
    }

    const filePaths = this.getProjectFiles(projectDir);
    return this.buildTree(filePaths, options);
  }

  /**
   * gitを使ってプロジェクトのファイル一覧を取得する
   * .gitと.gitignoreで除外されたファイルは含まれない
   * gitが利用できない場合は.gitのみ除外してファイルシステムを走査する
   */
  private getProjectFiles(projectDir: string): string[] {
    try {
      const output = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {
          cwd: projectDir,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      return output.split('\0').filter(Boolean);
    } catch {
      // gitが利用できないまたはgitリポジトリでない場合のフォールバック
      return this.walkFilesystem(projectDir);
    }
  }

  /**
   * フォールバック: ファイルシステムを直接走査（.gitのみ除外）
   */
  private walkFilesystem(projectDir: string): string[] {
    const files: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        try {
          const stat = fs.lstatSync(path.join(dir, entry.name));
          if (stat.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), relativePath);
        } else if (entry.isFile()) {
          files.push(relativePath);
        }
      }
    };
    walk(projectDir, '');
    return files;
  }

  /**
   * ファイルパスの一覧からインデント形式のツリー文字列を構築する
   */
  private buildTree(filePaths: string[], options: ProjectTreeOptions): string {
    // フラットなファイルパスからツリー構造を構築
    const root: TreeNode = { children: new Map() };

    for (const filePath of filePaths) {
      const parts = filePath.split('/');
      let current = root;
      for (const part of parts) {
        if (!current.children.has(part)) {
          current.children.set(part, { children: new Map() });
        }
        current = current.children.get(part)!;
      }
    }

    // ツリーを整形して出力
    const lines: string[] = [];
    let entryCount = 0;
    let truncated = false;

    const format = (node: TreeNode, indent: string, depth: number): void => {
      if (truncated) return;
      if (options.maxDepth !== undefined && depth > options.maxDepth) return;

      const entries = [...node.children.entries()];
      // ディレクトリ（子を持つノード）とファイル（リーフノード）に分離
      const dirs = entries
        .filter(([, n]) => n.children.size > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      const files = entries
        .filter(([, n]) => n.children.size === 0)
        .sort(([a], [b]) => a.localeCompare(b));

      // ディレクトリを先に出力
      for (const [name, child] of dirs) {
        if (entryCount >= this.maxEntries) {
          truncated = true;
          return;
        }
        lines.push(`${indent}${name}/`);
        entryCount++;
        format(child, indent + '  ', depth + 1);
      }

      // ファイルを出力
      for (const [name] of files) {
        if (entryCount >= this.maxEntries) {
          truncated = true;
          return;
        }
        lines.push(`${indent}${name}`);
        entryCount++;
      }
    };

    format(root, '', 1);

    if (truncated) {
      lines.push(`... (truncated, showing ${this.maxEntries} of more entries)`);
    }

    return lines.join('\n');
  }
}
