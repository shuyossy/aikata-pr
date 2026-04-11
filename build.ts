import { build } from 'esbuild';

// ESMバンドル内でCommonJSモジュール（pino等）のrequire/__dirname/__filenameを解決するためのシム
const bannerLines = [
  '#!/usr/bin/env node',
  'import { createRequire as __createRequire } from "module";',
  'import { fileURLToPath as __fileURLToPath } from "url";',
  'import { dirname as __pathDirname } from "path";',
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __pathDirname(__filename);',
].join('\n');

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.js',
  banner: {
    js: bannerLines,
  },
  packages: 'external',
  minify: false,
  sourcemap: true,
});

console.log('Build complete: dist/index.js');

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/server.js',
  banner: {
    js: bannerLines,
  },
  packages: 'external',
  minify: false,
  sourcemap: true,
});

console.log('Build complete: dist/server.js');
