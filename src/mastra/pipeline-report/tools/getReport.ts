import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as fsp from 'node:fs/promises';

/**
 * 分析レポートの現在の内容を取得するMastra Tool
 * 読み取りのみで排他制御は不要（レポート自体は楽観的に読む）
 */
export const getReportTool = createTool({
  id: 'get-report',
  description:
    'Read the current contents of the pipeline analysis report file. ' +
    'Use this to review the latest version of the report, especially before calling patch-report.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    content: z.string(),
  }),
  execute: async (_inputData, context) => {
    const filePath = context?.requestContext?.get('resultFilePath') as string | undefined;
    if (typeof filePath !== 'string' || filePath === '') {
      throw new Error('resultFilePath is not configured in RequestContext');
    }

    const content = await fsp.readFile(filePath, 'utf8');
    return { content };
  },
});
