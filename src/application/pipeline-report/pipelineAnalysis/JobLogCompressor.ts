import { stripFilesFromFolderTree } from '../../shared/diffCompression/FolderTreeStripper.js';
import type { TokenCounter } from '../../shared/port/tokenCounter/TokenCounter.js';

/**
 * ジョブログ圧縮の結果
 */
export interface JobLogCompressionResult {
  /** 圧縮処理が実行されたかどうか */
  compressed: boolean;
  /** 圧縮後のジョブログMap（compressed=falseの場合は元のMapの複製） */
  compressedJobLogs: Map<number, string>;
  /** フォルダツリーのファイルが除去されたかどうか */
  folderTreeStripped: boolean;
  /** ファイル除去後のフォルダツリー */
  strippedFolderTree: string;
  /** 各ジョブの省略された中央部分のみ（getJobLogDetailツール用） */
  omittedJobLogs: Map<number, string>;
  /** 圧縮されたジョブID一覧 */
  compressedJobIds: Set<number>;
}

/**
 * ジョブログ圧縮のオプション
 */
export interface JobLogCompressionOptions {
  maxContextLength: number;
  thresholdRatio: number;
  initialKeepPercent: number;
  keepPercentStep: number;
  minKeepPercent: number;
}

/**
 * 省略マーカーを生成する
 */
const buildOmissionMarker = (omittedChars: number): string =>
  `[aikata: ${omittedChars} chars omitted from middle of job log. Use getJobLogDetail tool with jobId to view omitted portion]`;

/**
 * 単一ジョブログをパーセンテージ指定で圧縮する
 * 上位x%と下位x%の行を保持し、中央部分を省略コメントで置換する
 *
 * @returns compressed: 圧縮後のログ文字列、omitted: 省略された中間部分の文字列
 */
export function compressJobLogByPercent(
  fullText: string,
  keepPercent: number,
): { compressed: string; omitted: string } {
  const lines = fullText.split('\n');
  const totalLines = lines.length;
  const keepLines = Math.floor((totalLines * keepPercent) / 100);

  // 圧縮不要: 保持行数が全体の半分以上、または保持行数が0（行数不足）
  if (keepLines === 0 || keepLines * 2 >= totalLines) {
    return { compressed: fullText, omitted: '' };
  }

  const headLines = lines.slice(0, keepLines);
  const tailLines = lines.slice(totalLines - keepLines);
  const omittedLines = lines.slice(keepLines, totalLines - keepLines);
  const omittedText = omittedLines.join('\n');
  const marker = buildOmissionMarker(omittedText.length);

  return {
    compressed: [...headLines, marker, ...tailLines].join('\n'),
    omitted: omittedText,
  };
}

/**
 * 単一ジョブログを行数指定で圧縮する
 * 上位keepLines行と下位keepLines行を保持し、中央部分を省略コメントで置換する
 * keepLines=0の場合はヘッダー行（1行目）のみ保持する
 *
 * @returns compressed: 圧縮後のログ文字列、omitted: 省略された部分の文字列
 */
export function compressJobLogByLines(
  fullText: string,
  keepLines: number,
): { compressed: string; omitted: string } {
  const lines = fullText.split('\n');
  const totalLines = lines.length;

  // keepLines=0: ヘッダー行（1行目）のみ保持
  if (keepLines === 0) {
    if (totalLines <= 1) {
      return { compressed: fullText, omitted: '' };
    }
    const headerLine = lines[0]!;
    const omittedLines = lines.slice(1);
    const omittedText = omittedLines.join('\n');
    const marker = buildOmissionMarker(omittedText.length);
    return {
      compressed: [headerLine, marker].join('\n'),
      omitted: omittedText,
    };
  }

  // 圧縮不要: 保持行数の合計が全体以上
  if (keepLines * 2 >= totalLines) {
    return { compressed: fullText, omitted: '' };
  }

  const headLines = lines.slice(0, keepLines);
  const tailLines = lines.slice(totalLines - keepLines);
  const omittedLines = lines.slice(keepLines, totalLines - keepLines);
  const omittedText = omittedLines.join('\n');
  const marker = buildOmissionMarker(omittedText.length);

  return {
    compressed: [...headLines, marker, ...tailLines].join('\n'),
    omitted: omittedText,
  };
}

/**
 * ユーザプロンプトのトークン数に基づいてジョブログを圧縮する
 *
 * アルゴリズム（review機能のDiffCompressorと同等）:
 * 1. userPromptのトークン数が閾値以下 → そのまま返す
 * 2. Step 1: フォルダツリーのファイル除去 → 再チェック
 * 3. Step 2 Phase 1: keepPercentを段階的に減らしながら最大ログを圧縮
 * 4. Step 2 Phase 2: minKeepPercentに達したログはkeepLines半減でさらに圧縮
 * 5. best-effortで閾値まで下げきれなくても compressed=true で返却（エラーは投げない）
 */
export function compressJobLogsIfNeeded(
  userPromptBuilder: (logs: Map<number, string>, folderTree: string) => string,
  originalLogs: Map<number, string>,
  folderTree: string,
  tokenCounter: TokenCounter,
  options: JobLogCompressionOptions,
): JobLogCompressionResult {
  const threshold = options.maxContextLength * options.thresholdRatio;

  // 閾値判定ヘルパー
  const isUnderThreshold = (logs: Map<number, string>, ft: string): boolean => {
    const prompt = userPromptBuilder(logs, ft);
    return tokenCounter.countTokens(prompt) <= threshold;
  };

  // 閾値以下ならそのまま返す
  if (isUnderThreshold(originalLogs, folderTree)) {
    return {
      compressed: false,
      compressedJobLogs: new Map(originalLogs),
      folderTreeStripped: false,
      strippedFolderTree: folderTree,
      omittedJobLogs: new Map(),
      compressedJobIds: new Set(),
    };
  }

  // Step 1: フォルダツリーのファイル行を除去
  const strippedFolderTree = stripFilesFromFolderTree(folderTree);
  const currentFolderTree = strippedFolderTree;
  const folderTreeStripped = strippedFolderTree !== folderTree;

  if (isUnderThreshold(originalLogs, currentFolderTree)) {
    return {
      compressed: true,
      compressedJobLogs: new Map(originalLogs),
      folderTreeStripped,
      strippedFolderTree,
      omittedJobLogs: new Map(),
      compressedJobIds: new Set(),
    };
  }

  // ジョブログが空の場合はbest-effortとしてここで終了
  if (originalLogs.size === 0) {
    return {
      compressed: true,
      compressedJobLogs: new Map(originalLogs),
      folderTreeStripped,
      strippedFolderTree,
      omittedJobLogs: new Map(),
      compressedJobIds: new Set(),
    };
  }

  // 作業用データ
  const currentLogs = new Map<number, string>(originalLogs);
  const omittedJobLogs = new Map<number, string>();
  const compressedJobIds = new Set<number>();
  const jobKeepPercents = new Map<number, number>();

  // ジョブログの現在の行数を取得
  const getLineCount = (jobId: number): number => {
    const text = currentLogs.get(jobId);
    return text ? text.split('\n').length : 0;
  };

  // Step 2 Phase 1: keepPercentベースの段階的圧縮
  for (;;) {
    // 現在の行数でソートし、最大のログを選択
    const sortedJobs = Array.from(currentLogs.keys()).sort(
      (a, b) => getLineCount(b) - getLineCount(a),
    );

    // 圧縮可能なジョブを探す
    let targetJob: number | null = null;
    for (const jobId of sortedJobs) {
      const currentKeep = jobKeepPercents.get(jobId);
      if (currentKeep !== undefined && currentKeep <= options.minKeepPercent) {
        // このジョブはこれ以上パーセンテージ圧縮できない
        continue;
      }
      targetJob = jobId;
      break;
    }

    // 全ジョブがminKeepPercentに達した → Phase 2へ
    if (targetJob === null) {
      break;
    }

    // keepPercentを決定
    const currentKeep = jobKeepPercents.get(targetJob);
    const newKeepPercent =
      currentKeep !== undefined
        ? Math.max(currentKeep - options.keepPercentStep, options.minKeepPercent)
        : options.initialKeepPercent;

    jobKeepPercents.set(targetJob, newKeepPercent);

    // オリジナルログに対して圧縮
    const originalText = originalLogs.get(targetJob)!;
    const { compressed, omitted } = compressJobLogByPercent(originalText, newKeepPercent);

    currentLogs.set(targetJob, compressed);
    if (omitted) {
      omittedJobLogs.set(targetJob, omitted);
      compressedJobIds.add(targetJob);
    }

    // 再チェック
    if (isUnderThreshold(currentLogs, currentFolderTree)) {
      return {
        compressed: true,
        compressedJobLogs: currentLogs,
        folderTreeStripped,
        strippedFolderTree,
        omittedJobLogs,
        compressedJobIds,
      };
    }
  }

  // Step 2 Phase 2: 行数ベースの段階的圧縮（keepLines半減ループ）
  const jobKeepLines = new Map<number, number>();

  // Phase 1完了時のkeepLinesを初期値として算出
  for (const [jobId, keepPercent] of jobKeepPercents) {
    if (keepPercent <= options.minKeepPercent) {
      const originalText = originalLogs.get(jobId)!;
      const totalLines = originalText.split('\n').length;
      const currentKeepLines = Math.floor((totalLines * keepPercent) / 100);
      // keepLinesが0の場合（元々小さいログ）は対象外
      if (currentKeepLines > 0) {
        jobKeepLines.set(jobId, currentKeepLines);
      }
    }
  }

  for (;;) {
    const sortedJobs = Array.from(currentLogs.keys()).sort(
      (a, b) => getLineCount(b) - getLineCount(a),
    );

    // 圧縮可能なジョブを探す（jobKeepLinesに存在し、keepLines > 0のもの）
    let targetJob: number | null = null;
    for (const jobId of sortedJobs) {
      if (!jobKeepLines.has(jobId)) {
        continue;
      }
      const currentKeep = jobKeepLines.get(jobId)!;
      if (currentKeep <= 0) {
        continue;
      }
      targetJob = jobId;
      break;
    }

    // 全ジョブがkeepLines=0に達した → ベストエフォートで完了
    if (targetJob === null) {
      break;
    }

    // keepLinesを半減
    const currentKeepLines = jobKeepLines.get(targetJob)!;
    const newKeepLines = Math.floor(currentKeepLines / 2);
    jobKeepLines.set(targetJob, newKeepLines);

    // オリジナルログに対して行数ベースで圧縮
    const originalText = originalLogs.get(targetJob)!;
    const { compressed, omitted } = compressJobLogByLines(originalText, newKeepLines);

    currentLogs.set(targetJob, compressed);
    if (omitted) {
      omittedJobLogs.set(targetJob, omitted);
      compressedJobIds.add(targetJob);
    }

    // 再チェック
    if (isUnderThreshold(currentLogs, currentFolderTree)) {
      return {
        compressed: true,
        compressedJobLogs: currentLogs,
        folderTreeStripped,
        strippedFolderTree,
        omittedJobLogs,
        compressedJobIds,
      };
    }
  }

  // ベストエフォート: 全ジョブを圧縮してもなお閾値を超えている
  return {
    compressed: true,
    compressedJobLogs: currentLogs,
    folderTreeStripped,
    strippedFolderTree,
    omittedJobLogs,
    compressedJobIds,
  };
}
