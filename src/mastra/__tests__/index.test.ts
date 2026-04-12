import { describe, it, expect } from 'vitest';
import { mastra } from '../index.js';

describe('mastra instance registration', () => {
  describe('review 機能の登録', () => {
    it('reviewAgent / checklistSplitAgent / summarizationAgent が登録されている', () => {
      expect(mastra.getAgent('reviewAgent')).toBeDefined();
      expect(mastra.getAgent('checklistSplitAgent')).toBeDefined();
      expect(mastra.getAgent('summarizationAgent')).toBeDefined();
    });

    it('reviewWorkflow が登録されている', () => {
      const workflow = mastra.getWorkflow('reviewWorkflow');
      expect(workflow).toBeDefined();
      expect(workflow.id).toBe('review-workflow');
    });
  });

  describe('pipeline-report 機能の登録', () => {
    it('pipelineAnalysisAgent が登録されている', () => {
      const agent = mastra.getAgent('pipelineAnalysisAgent');
      expect(agent).toBeDefined();
      expect(agent.id).toBe('pipeline-analysis-agent');
      expect(agent.name).toBe('Pipeline Analysis Agent');
    });

    it('reportCompletenessJudgeAgent が登録されている', () => {
      const agent = mastra.getAgent('reportCompletenessJudgeAgent');
      expect(agent).toBeDefined();
      expect(agent.id).toBe('report-completeness-judge-agent');
      expect(agent.name).toBe('Report Completeness Judge Agent');
    });

    it('pipelineReportSummarizationAgent が登録されている', () => {
      const agent = mastra.getAgent('pipelineReportSummarizationAgent');
      expect(agent).toBeDefined();
      expect(agent.id).toBe('pipeline-report-summarization-agent');
      expect(agent.name).toBe('Pipeline Report Summarization Agent');
    });

    it('pipelineAnalysisWorkflow が登録されている', () => {
      const workflow = mastra.getWorkflow('pipelineAnalysisWorkflow');
      expect(workflow).toBeDefined();
      expect(workflow.id).toBe('pipeline-analysis-workflow');
    });
  });
});
