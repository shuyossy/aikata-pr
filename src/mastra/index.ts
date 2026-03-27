import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { reviewWorkflow } from './workflows/index.js';

export const mastra = new Mastra({
  workflows: { reviewWorkflow },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
