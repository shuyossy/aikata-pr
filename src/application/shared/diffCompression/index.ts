export {
  splitDiffByFile,
  compressFileDiff,
  combineFileDiffs,
  compressDiffIfNeeded,
} from './DiffCompressor.js';
export type { DiffCompressionResult, DiffCompressionOptions } from './DiffCompressor.js';
export { stripFilesFromFolderTree } from './FolderTreeStripper.js';
