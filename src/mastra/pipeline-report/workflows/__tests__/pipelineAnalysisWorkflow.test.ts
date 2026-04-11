import { describe, it, expect } from 'vitest';
import {
  pipelineAnalysisWorkflow,
  workflowInputSchema,
  workflowOutputSchema,
} from '../pipelineAnalysisWorkflow.js';

describe('pipelineAnalysisWorkflow', () => {
  it('正しい id と schema を持つ', () => {
    expect(pipelineAnalysisWorkflow.id).toBe('pipeline-analysis-workflow');
    expect(pipelineAnalysisWorkflow.inputSchema).toBeDefined();
    expect(pipelineAnalysisWorkflow.outputSchema).toBeDefined();
  });

  it('入力スキーマは正常な入力を受け付ける', () => {
    const validInput = {
      initialUserPrompt: 'Analyze the pipeline',
      targetJobs: [
        {
          id: 101,
          name: 'build',
          stage: 'build',
          status: 'success' as const,
          duration: 42,
        },
      ],
      overallTemplate: '# Report',
      jobReportFormat: '### Job <jobId>',
      additionalInstructions: null,
      resultFilePath: '/tmp/report.md',
      commentLanguage: 'Japanese',
      maxCompletenessRetries: 3,
    };

    const result = workflowInputSchema.safeParse(validInput);

    expect(result.success).toBe(true);
  });

  it('入力スキーマは不正な入力（必須フィールド欠落）を拒否する', () => {
    const invalidInput = {
      initialUserPrompt: 'Analyze',
      // targetJobs 等が欠落
    };

    const result = workflowInputSchema.safeParse(invalidInput);

    expect(result.success).toBe(false);
  });

  it('入力スキーマは additionalInstructions の null を許容する', () => {
    const input = {
      initialUserPrompt: 'Analyze',
      targetJobs: [],
      overallTemplate: '# Report',
      jobReportFormat: '### Job',
      additionalInstructions: null,
      resultFilePath: '/tmp/report.md',
      commentLanguage: 'Japanese',
      maxCompletenessRetries: 0,
    };

    const result = workflowInputSchema.safeParse(input);

    expect(result.success).toBe(true);
  });

  it('出力スキーマは reportContent / completenessVerified / completenessRetries を必須とする', () => {
    const validOutput = {
      reportContent: '# Done',
      completenessVerified: true,
      completenessRetries: 0,
    };

    const result = workflowOutputSchema.safeParse(validOutput);

    expect(result.success).toBe(true);
  });

  it('出力スキーマは reportContent 欠落を拒否する', () => {
    const invalid = {
      completenessVerified: true,
      completenessRetries: 0,
    };

    const result = workflowOutputSchema.safeParse(invalid);

    expect(result.success).toBe(false);
  });
});
