/**
 * pipeline-report のテストフィクスチャ（zip）をワンショット生成するスクリプト。
 *
 * 使い方:
 *   npx tsx tools/scripts/gen-test-fixtures.ts
 *
 * 生成物:
 *   - src/application/pipeline-report/pipelineAnalysis/__tests__/fixtures/artifacts/sample.zip
 *
 * 方針:
 *   - 外部プロセス呼び出しは行わず、pure JSのyazlでzipを生成する
 *   - 生成したzipはリポジトリにcommitし、テスト中は再生成せず読み取るだけとする
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_PATH = resolve(
  __dirname,
  '../../src/application/pipeline-report/pipelineAnalysis/__tests__/fixtures/artifacts/sample.zip',
);

async function main(): Promise<void> {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });

  const zipfile = new yazl.ZipFile();
  // テスト用のダミーファイル2つを追加
  zipfile.addBuffer(Buffer.from('hello world', 'utf8'), 'content-a.txt');
  zipfile.addBuffer(Buffer.from('binary\x00data', 'utf8'), 'content-b.txt');
  // ストリーム halt 検証用の大容量エントリ（64KB の決定的バイト列）
  // deterministic にするため固定パターンを使用（random ではなくシード的値）
  const largeBuffer = Buffer.alloc(64 * 1024);
  for (let i = 0; i < largeBuffer.length; i += 1) {
    largeBuffer[i] = i % 256;
  }
  zipfile.addBuffer(largeBuffer, 'large.bin');
  zipfile.end();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const out = createWriteStream(OUTPUT_PATH);
    out.on('finish', () => resolvePromise());
    out.on('error', rejectPromise);
    zipfile.outputStream.pipe(out);
  });

  // eslint-disable-next-line no-console
  console.log(`generated: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
