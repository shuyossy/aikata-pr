import type {
  LineResolveResult,
  SuggestionLineResolver,
} from '../../../../application/shared/port/suggestion/index.js';
import { splitDiffByFile } from '../../../../application/shared/diffCompression/DiffCompressor.js';

/**
 * new側の行情報（diffから抽出された行）
 */
interface NewSideLine {
  /** 行のコンテンツ（diffプレフィックスを除去済み） */
  content: string;
  /** new側の行番号 */
  newLineNum: number;
}

/**
 * ファイルdiffから抽出されたパス情報
 */
interface DiffPaths {
  oldPath: string;
  newPath: string;
}

/**
 * diffを解析してコード断片から行番号を解決するインフラ実装
 * splitDiffByFile()を利用してファイルごとのdiffに分割し、
 * ハンクヘッダーを解析して行番号を追跡する
 */
export class DiffBasedSuggestionLineResolver implements SuggestionLineResolver {
  resolve(filePath: string, originalCode: string, mrDiff: string): LineResolveResult {
    // 空のoriginalCodeチェック
    if (!originalCode.trim()) {
      return {
        success: false,
        errorMessage: 'originalCode is empty. Provide the code snippet to locate in the diff.',
      };
    }

    // ファイルごとにdiffを分割
    const fileDiffs = splitDiffByFile(mrDiff);

    // ファイルdiffを検索（完全一致 → サフィックスマッチ）
    const fileDiffEntry = this.findFileDiff(filePath, fileDiffs);

    if (!fileDiffEntry) {
      return {
        success: false,
        errorMessage: `File '${filePath}' not found in the diff. Available files: ${Array.from(fileDiffs.keys()).join(', ') || '(none)'}`,
      };
    }

    const [matchedPath, fileDiff] = fileDiffEntry;

    // パス情報を抽出
    const paths = this.extractPaths(fileDiff, matchedPath);

    // new側の行を抽出（ハンク境界を区切りとして管理）
    const newSideLineGroups = this.extractNewSideLines(fileDiff);

    // originalCodeを行に分割（末尾の空行は除去）
    const codeLines = this.splitCodeLines(originalCode);

    // コード断片を検索
    const matches = this.findCodeMatches(newSideLineGroups, codeLines);

    if (matches.length === 0) {
      // 完全一致失敗 → 全空白除去フォールバックを試行
      const normalizedMatches = this.findCodeMatchesNormalized(newSideLineGroups, originalCode);

      if (normalizedMatches.length === 1) {
        const match = normalizedMatches[0]!;
        return {
          success: true,
          newLine: match.startLine.newLineNum,
          linesAbove: 0,
          linesBelow: match.lineCount - 1,
          oldPath: paths.oldPath,
          newPath: paths.newPath,
        };
      }

      if (normalizedMatches.length > 1) {
        return {
          success: false,
          errorMessage: `Found ${normalizedMatches.length} matches (after ignoring whitespace) for the given code in '${filePath}'. Include more surrounding context lines in originalCode to uniquely identify the location.`,
        };
      }

      return {
        success: false,
        errorMessage: `Code not found in diff for file '${filePath}' even after ignoring all whitespace. Verify that the code appears in the new side of the diff.`,
      };
    }

    if (matches.length > 1) {
      return {
        success: false,
        errorMessage: `Found ${matches.length} matches for the given code in '${filePath}'. Include more surrounding context lines in originalCode to uniquely identify the location.`,
      };
    }

    // 一意にマッチ
    const match = matches[0]!;
    return {
      success: true,
      newLine: match.newLineNum,
      linesAbove: 0,
      linesBelow: codeLines.length - 1,
      oldPath: paths.oldPath,
      newPath: paths.newPath,
    };
  }

  /**
   * ファイルパスに一致するdiffエントリを検索する
   * 完全一致 → サフィックスマッチの順に試行
   */
  private findFileDiff(filePath: string, fileDiffs: Map<string, string>): [string, string] | null {
    // 完全一致
    if (fileDiffs.has(filePath)) {
      return [filePath, fileDiffs.get(filePath)!];
    }

    // サフィックスマッチ（filePathがdiffキーの末尾に一致）
    for (const [key, value] of fileDiffs) {
      if (key.endsWith(`/${filePath}`) || key === filePath) {
        return [key, value];
      }
    }

    // プレフィックスマッチ（diffキーがfilePathの末尾に一致）
    for (const [key, value] of fileDiffs) {
      if (filePath.endsWith(`/${key}`) || filePath.endsWith(key)) {
        return [key, value];
      }
    }

    return null;
  }

  /**
   * diffヘッダーからoldPathとnewPathを抽出する
   */
  private extractPaths(fileDiff: string, fallbackPath: string): DiffPaths {
    const lines = fileDiff.split('\n');

    let oldPath = fallbackPath;
    let newPath = fallbackPath;

    // "--- a/path" または "--- /dev/null" を検索
    for (const line of lines) {
      if (line.startsWith('--- ')) {
        const path = line.substring(4);
        if (path === '/dev/null') {
          oldPath = '/dev/null';
        } else if (path.startsWith('a/')) {
          oldPath = path.substring(2);
        } else {
          oldPath = path;
        }
        break;
      }
    }

    // "+++ b/path" を検索
    for (const line of lines) {
      if (line.startsWith('+++ ')) {
        const path = line.substring(4);
        if (path === '/dev/null') {
          newPath = '/dev/null';
        } else if (path.startsWith('b/')) {
          newPath = path.substring(2);
        } else {
          newPath = path;
        }
        break;
      }
    }

    return { oldPath, newPath };
  }

  /**
   * ファイルdiffからnew側の行を抽出する
   * ハンクごとにグループ分けし、ハンク間の不連続性を保持する
   */
  private extractNewSideLines(fileDiff: string): NewSideLine[][] {
    const lines = fileDiff.split('\n');
    const hunkGroups: NewSideLine[][] = [];
    let currentGroup: NewSideLine[] = [];
    let newLineNum = 0;
    let inHunk = false;

    for (const line of lines) {
      // ハンクヘッダーの解析: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        // 前のハンクのグループを保存
        if (currentGroup.length > 0) {
          hunkGroups.push(currentGroup);
          currentGroup = [];
        }
        newLineNum = parseInt(hunkMatch[1]!, 10);
        inHunk = true;
        continue;
      }

      if (!inHunk) continue;

      if (line.startsWith('+')) {
        // 追加行: new側のみ
        currentGroup.push({
          content: line.substring(1),
          newLineNum,
        });
        newLineNum++;
      } else if (line.startsWith('-')) {
        // 削除行: old側のみ、new側には影響なし
        // newLineNumは変更しない
      } else if (line.startsWith(' ') || line === '') {
        // コンテキスト行: 両側
        // 注意: 空行はスペースプレフィックスが省略される場合がある（GitLabのdiff出力）
        const content = line.startsWith(' ') ? line.substring(1) : line;
        currentGroup.push({
          content,
          newLineNum,
        });
        newLineNum++;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" 等はスキップ
      }
      // その他の行はスキップ
    }

    // 最後のグループを保存
    if (currentGroup.length > 0) {
      hunkGroups.push(currentGroup);
    }

    return hunkGroups;
  }

  /**
   * originalCodeを行に分割する（末尾の空行を除去）
   */
  private splitCodeLines(originalCode: string): string[] {
    const lines = originalCode.split('\n');
    // 末尾の空行を除去（末尾改行対応）
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  /**
   * ハンクグループ内でコード断片の連続マッチを検索する
   * ハンク境界を跨ぐマッチは行わない
   */
  private findCodeMatches(hunkGroups: NewSideLine[][], codeLines: string[]): NewSideLine[] {
    const matches: NewSideLine[] = [];

    if (codeLines.length === 0) return matches;

    for (const group of hunkGroups) {
      // グループ内で連続マッチを検索
      for (let i = 0; i <= group.length - codeLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < codeLines.length; j++) {
          if (group[i + j]!.content !== codeLines[j]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          matches.push(group[i]!);
        }
      }
    }

    return matches;
  }

  /**
   * 全空白・改行を除去してコード断片のマッチを検索するフォールバック
   * スライディングウィンドウ方式で、diff側の連続行を結合しつつ空白除去して比較する
   * ハンク境界を跨ぐマッチは行わない
   */
  private findCodeMatchesNormalized(
    hunkGroups: NewSideLine[][],
    originalCode: string,
  ): { startLine: NewSideLine; lineCount: number }[] {
    const matches: { startLine: NewSideLine; lineCount: number }[] = [];
    const normalizedCode = originalCode.replace(/\s+/g, '');
    if (!normalizedCode) return matches;

    for (const group of hunkGroups) {
      for (let startIdx = 0; startIdx < group.length; startIdx++) {
        let accumulated = '';
        for (let endIdx = startIdx; endIdx < group.length; endIdx++) {
          accumulated += group[endIdx]!.content.replace(/\s+/g, '');
          if (accumulated === normalizedCode) {
            matches.push({ startLine: group[startIdx]!, lineCount: endIdx - startIdx + 1 });
            break;
          }
          if (accumulated.length > normalizedCode.length) {
            break;
          }
        }
      }
    }

    return matches;
  }
}
