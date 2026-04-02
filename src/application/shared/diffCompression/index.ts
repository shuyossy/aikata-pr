export {
  splitDiffByFile,
  compressFileDiff,
  compressFileDiffByLines,
  combineFileDiffs,
  compressDiffIfNeeded,
} from './DiffCompressor.js';
export type { DiffCompressionResult, DiffCompressionOptions } from './DiffCompressor.js';
export { stripFilesFromFolderTree } from './FolderTreeStripper.js';
