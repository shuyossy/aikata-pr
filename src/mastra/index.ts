import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { reviewWorkflow } from './workflows/index.js';
import { reviewAgent } from './agents/reviewAgent.js';
import { checklistSplitAgent } from './agents/checklistSplitAgent.js';

export const mastra = new Mastra({
  agents: { reviewAgent, checklistSplitAgent },
  workflows: { reviewWorkflow },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
