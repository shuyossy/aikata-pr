import { reviewCliModule } from './review/index.js';
import { pipelineReportCliModule } from './pipeline-report/index.js';

/**
 * CLI機能モジュールのインターフェース。
 * 各機能は name / description / run を持つ記述子をexportする。
 */
export interface CliFeatureModule {
  name: string;
  description: string;
  run: (args: string[]) => Promise<void>;
}

/**
 * デフォルトで登録される機能モジュール。
 * 将来新機能を追加する際はここに1行追加する。
 */
export const defaultFeatures: CliFeatureModule[] = [reviewCliModule, pipelineReportCliModule];

export function printUsage(features: CliFeatureModule[]): void {
  const lines = [
    'Usage: aikata-pr <command> [options]',
    '',
    'Commands:',
    ...features.map((f) => `  ${f.name.padEnd(12)} ${f.description}`),
  ];
  console.error(lines.join('\n'));
}

/**
 * サブコマンドディスパッチャ本体。テスト容易性のためexport。
 *
 * @param argv - process.argv.slice(2) 相当
 * @param features - 登録機能モジュール配列（未指定時はdefaultFeatures）
 */
export async function dispatch(
  argv: string[],
  features: CliFeatureModule[] = defaultFeatures,
): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (!subcommand) {
    printUsage(features);
    process.exit(1);
  }

  const feature = features.find((f) => f.name === subcommand);
  if (!feature) {
    console.error(`Unknown command: ${subcommand}`);
    printUsage(features);
    process.exit(1);
  }

  await feature.run(rest);
}
