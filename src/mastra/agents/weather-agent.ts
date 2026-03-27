import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { weatherTool } from '../tools/weather-tool';
import { scorers } from '../scorers/weather-scorer';

export const weatherAgent = new Agent({
  id: 'weather-agent',
  name: 'Weather Agent',
  instructions: `
      Answer in Japanese.
`,
  model: 'openai/gpt-5-mini',
  // tools: { weatherTool },
  // scorers: {
  //   toolCallAppropriateness: {
  //     scorer: scorers.toolCallAppropriatenessScorer,
  //     sampling: {
  //       type: 'ratio',
  //       rate: 1,
  //     },
  //   },
  //   completeness: {
  //     scorer: scorers.completenessScorer,
  //     sampling: {
  //       type: 'ratio',
  //       rate: 1,
  //     },
  //   },
  //   translation: {
  //     scorer: scorers.translationScorer,
  //     sampling: {
  //       type: 'ratio',
  //       rate: 1,
  //     },
  //   },
  // },
  memory: new Memory(),
});
