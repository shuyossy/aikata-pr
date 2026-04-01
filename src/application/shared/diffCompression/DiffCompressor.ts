import type { TokenCounter } from '../port/tokenCounter/index.js';
import { stripFilesFromFolderTree } from './FolderTreeStripper.js';

/**
 * diff圧縮の結果
 */
export interface DiffCompressionResult {
  /** 圧縮処理が実行されたかどうか */
  compressed: boolean;
  /** 圧縮後のdiff文字列（compressed=falseの場合は元のdiff） */
  compressedDiff: string;
  /** フォルダツリーのファイルが除去されたかどうか */
  folderTreeStripped: boolean;
  /** ファイル除去後のフォルダツリー */
  strippedFolderTree: string;
  /** 各ファイルの省略された中間部分のみ（getDiffDetailツール用） */
  omittedFileDiffs: Map<string, string>;
  /** 圧縮されたファイルのパス一覧 */
  compressedFilePaths: Set<string>;
  /** diff内の全ファイルパス一覧（圧縮有無問わず） */
  allDiffFilePaths: Set<string>;
}

/**
 * diff圧縮のオプション
 */
export interface DiffCompressionOptions {
  maxContextLength: number;
  thresholdRatio: number;
  initialKeepPercent: number;
  keepPercentStep: number;
  minKeepPercent: number;
}

/**
 * 統合diff文字列をファイルごとに分割する
 * GitLab diff形式: "diff --git a/path b/path" で始まるブロック
 */
export function splitDiffByFile(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!diff.trim()) return result;

  // "diff --git" ヘッダーで分割
  const filePattern = /^diff --git /m;
  const parts = diff.split(filePattern);

  for (const part of parts) {
    if (!part.trim()) continue;

    const fullBlock = `diff --git ${part}`;

    // b/path を取得（"diff --git a/... b/..." の形式）
    const headerLine = fullBlock.split('\n')[0]!;
    const bPathMatch = headerLine.match(/ b\/(.+)$/);
    if (bPathMatch) {
      result.set(bPathMatch[1]!, fullBlock);
    }
  }

  return result;
}

/**
 * 単一ファイルのdiffを圧縮する
 * 上位x%と下位x%の行を保持し、中央部分を省略コメントで置換する
 *
 * @returns compressed: 圧縮後のdiff文字列、omitted: 省略された中間部分の文字列
 */
export function compressFileDiff(
  fileDiff: string,
  keepPercent: number,
): { compressed: string; omitted: string } {
  const lines = fileDiff.split('\n');
  const totalLines = lines.length;
  const keepLines = Math.floor((totalLines * keepPercent) / 100);

  // 圧縮不要: 保持行数が全体の半分以上、または保持行数が0（行数不足）
  if (keepLines === 0 || keepLines * 2 >= totalLines) {
    return { compressed: fileDiff, omitted: '' };
  }

  const topLines = lines.slice(0, keepLines);
  const bottomLines = lines.slice(totalLines - keepLines);
  const omittedLines = lines.slice(keepLines, totalLines - keepLines);
  const omittedCount = omittedLines.length;

  const omissionMarker = `[aikata: ${omittedCount} lines omitted from middle. Use getDiffDetail tool with file path to view omitted portion]`;

  return {
    compressed: [...topLines, omissionMarker, ...bottomLines].join('\n'),
    omitted: omittedLines.join('\n'),
  };
}

/**
 * 圧縮されたファイルdiffを結合して1つのdiff文字列に戻す
 */
export function combineFileDiffs(fileDiffs: Map<string, string>): string {
  if (fileDiffs.size === 0) return '';
  return Array.from(fileDiffs.values()).join('\n');
}

/**
 * ユーザプロンプトのトークン数に基づいてdiffを圧縮する
 *
 * アルゴリズム:
 * 1. userPromptのトークン数が閾値以下 → そのまま返す
 * 2. Step 1: フォルダツリーのファイル除去 → 再チェック
 * 3. Step 2: diff圧縮（毎回最大のファイルを1つずつ圧縮）
 */
export function compressDiffIfNeeded(
  userPromptBuilder: (diff: string, folderTree: string) => string,
  originalDiff: string,
  folderTree: string,
  tokenCounter: TokenCounter,
  options: DiffCompressionOptions,
): DiffCompressionResult {
  const threshold = options.maxContextLength * options.thresholdRatio;

  // 閾値判定ヘルパー
  const isUnderThreshold = (diff: string, ft: string): boolean => {
    const prompt = userPromptBuilder(diff, ft);
    return tokenCounter.countTokens(prompt) <= threshold;
  };

  // diff内の全ファイルパスを取得（圧縮有無判定に使用）
  const allDiffFilePaths = new Set(splitDiffByFile(originalDiff).keys());

  // 閾値以下ならそのまま返す
  if (isUnderThreshold(originalDiff, folderTree)) {
    return {
      compressed: false,
      compressedDiff: originalDiff,
      folderTreeStripped: false,
      strippedFolderTree: folderTree,
      omittedFileDiffs: new Map(),
      compressedFilePaths: new Set(),
      allDiffFilePaths,
    };
  }

  // Step 1: フォルダツリーのファイル除去
  const strippedFolderTree = stripFilesFromFolderTree(folderTree);
  const currentFolderTree = strippedFolderTree;
  const folderTreeStripped = strippedFolderTree !== folderTree;

  if (isUnderThreshold(originalDiff, currentFolderTree)) {
    return {
      compressed: true,
      compressedDiff: originalDiff,
      folderTreeStripped,
      strippedFolderTree,
      omittedFileDiffs: new Map(),
      compressedFilePaths: new Set(),
      allDiffFilePaths,
    };
  }

  // Step 2: diff圧縮（毎回最大のファイルを1つずつ）
  const originalFileDiffs = splitDiffByFile(originalDiff);

  // diffが分割できない場合（diffヘッダーがない場合など）はそのまま返す
  if (originalFileDiffs.size === 0) {
    return {
      compressed: true,
      compressedDiff: originalDiff,
      folderTreeStripped,
      strippedFolderTree,
      omittedFileDiffs: new Map(),
      compressedFilePaths: new Set(),
      allDiffFilePaths,
    };
  }

  // 作業用データ
  const currentFileDiffs = new Map<string, string>(originalFileDiffs);
  const omittedFileDiffs = new Map<string, string>();
  const compressedFilePaths = new Set<string>();
  const fileKeepPercents = new Map<string, number>();

  // ファイルの現在のdiff行数を取得
  const getLineCount = (filePath: string): number => {
    const diff = currentFileDiffs.get(filePath);
    return diff ? diff.split('\n').length : 0;
  };

  while (true) {
    // 現在のdiff行数でソートし、最も大きいファイルを選択
    const sortedFiles = Array.from(currentFileDiffs.keys()).sort(
      (a, b) => getLineCount(b) - getLineCount(a),
    );

    // 圧縮可能なファイルを探す
    let targetFile: string | null = null;
    for (const file of sortedFiles) {
      const currentKeep = fileKeepPercents.get(file);
      if (currentKeep !== undefined && currentKeep <= options.minKeepPercent) {
        // このファイルはこれ以上圧縮できない
        continue;
      }
      targetFile = file;
      break;
    }

    // 全ファイルがminKeepPercentに達した → ベストエフォートで完了
    if (targetFile === null) {
      break;
    }

    // keepPercentを決定
    const currentKeep = fileKeepPercents.get(targetFile);
    const newKeepPercent =
      currentKeep !== undefined
        ? Math.max(currentKeep - options.keepPercentStep, options.minKeepPercent)
        : options.initialKeepPercent;

    fileKeepPercents.set(targetFile, newKeepPercent);

    // オリジナルdiffに対して圧縮
    const originalFileDiff = originalFileDiffs.get(targetFile)!;
    const { compressed, omitted } = compressFileDiff(originalFileDiff, newKeepPercent);

    currentFileDiffs.set(targetFile, compressed);
    if (omitted) {
      omittedFileDiffs.set(targetFile, omitted);
      compressedFilePaths.add(targetFile);
    }

    // 再結合してトークン数チェック
    const combinedDiff = combineFileDiffs(currentFileDiffs);
    if (isUnderThreshold(combinedDiff, currentFolderTree)) {
      return {
        compressed: true,
        compressedDiff: combinedDiff,
        folderTreeStripped,
        strippedFolderTree,
        omittedFileDiffs,
        compressedFilePaths,
        allDiffFilePaths,
      };
    }
  }

  // ベストエフォート: 全ファイル圧縮済みで閾値を超えている
  return {
    compressed: true,
    compressedDiff: combineFileDiffs(currentFileDiffs),
    folderTreeStripped,
    strippedFolderTree,
    omittedFileDiffs,
    compressedFilePaths,
    allDiffFilePaths,
  };
}
