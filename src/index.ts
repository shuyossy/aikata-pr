import { parseCliOptions } from './lib/cli.js';
import { initializeLogger, getLogger } from './lib/logger.js';

/**
 * チェックロジックのエントリーポイント
 */
function main(): void {
  const options = parseCliOptions(process.argv.slice(2), process.env as Record<string, string>);

  initializeLogger({
    userId: options.userId ?? 'unknown',
    level: options.logLevel,
  });

  const logger = getLogger();
  logger.info('aikata-pr started');
  logger.info({ options }, 'parsed options');
}

main();
