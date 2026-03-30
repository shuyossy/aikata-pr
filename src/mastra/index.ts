import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { reviewWorkflow } from './workflows/index.js';
import { reviewAgent } from './agents/reviewAgent.js';
import { checklistSplitAgent } from './agents/checklistSplitAgent.js';
import { summarizationAgent } from './agents/summarizationAgent.js';

export const mastra = new Mastra({
  storage: new LibSQLStore({ id: 'mastra-storage', url: 'file:mastra.db' }),
  agents: { reviewAgent, checklistSplitAgent, summarizationAgent },
  workflows: { reviewWorkflow },
  logger: new PinoLogger({
    name: 'Mastra',
    level: (process.env['AIKATA_LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
  }),
});
