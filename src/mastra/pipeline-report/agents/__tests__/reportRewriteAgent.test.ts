import { describe, it, expect } from 'vitest';
import {
  reportRewriteAgent,
  REPORT_REWRITE_AGENT_INSTRUCTIONS,
  buildReportRewriteUserPrompt,
} from '../reportRewriteAgent.js';
import type { BuildReportRewriteUserPromptInputs } from '../reportRewriteAgent.js';

describe('REPORT_REWRITE_AGENT_INSTRUCTIONS', () => {
  it('元の内容を保持する制約（preserve）が含まれる', () => {
    expect(REPORT_REWRITE_AGENT_INSTRUCTIONS).toContain('preserve');
  });

  it('元の内容（original）への言及が含まれる', () => {
    expect(REPORT_REWRITE_AGENT_INSTRUCTIONS).toContain('original');
  });

  it('Output ONLY 指示がボールド強調されている', () => {
    expect(REPORT_REWRITE_AGENT_INSTRUCTIONS).toContain(
      '**Output ONLY the complete rewritten report**',
    );
  });

  it('レポート以外の出力を禁止する指示がボールド強調されている', () => {
    expect(REPORT_REWRITE_AGENT_INSTRUCTIONS).toContain(
      '**Do not include ANY explanations, preamble, or commentary**',
    );
  });

  it('レポート以外の出力を禁止する追加の強調指示が含まれる', () => {
    expect(REPORT_REWRITE_AGENT_INSTRUCTIONS).toContain(
      '**IMPORTANT: Your entire response must be the report itself',
    );
  });
});

describe('buildReportRewriteUserPrompt', () => {
  const baseInputs: BuildReportRewriteUserPromptInputs = {
    currentReportContent: '# Pipeline Analysis Report\n\n## Job #1\nSome analysis',
    finalizationActions: ['Reorder job sections by severity', 'Fix stage ordering within groups'],
    reportRefinementInstructions: null,
    commentLanguage: 'Japanese',
  };

  it('reportRefinementInstructionsが指定されている場合、プロンプトに含まれる', () => {
    const inputs: BuildReportRewriteUserPromptInputs = {
      ...baseInputs,
      reportRefinementInstructions: 'Hide jobs with no issues from the report.',
    };

    const result = buildReportRewriteUserPrompt(inputs);

    expect(result).toContain('User-Specified Report Refinement Instructions');
    expect(result).toContain('Hide jobs with no issues from the report.');
  });

  it('reportRefinementInstructionsがnullの場合、推敲指示セクションが含まれない', () => {
    const result = buildReportRewriteUserPrompt(baseInputs);

    expect(result).not.toContain('User-Specified Report Refinement Instructions');
  });

  it('finalizationActionsが箇条書きとしてリストされる', () => {
    const result = buildReportRewriteUserPrompt(baseInputs);

    expect(result).toContain('- Reorder job sections by severity');
    expect(result).toContain('- Fix stage ordering within groups');
  });

  it('currentReportContentがコードブロック内に含まれる', () => {
    const result = buildReportRewriteUserPrompt(baseInputs);

    expect(result).toContain('```markdown');
    expect(result).toContain('# Pipeline Analysis Report');
    expect(result).toContain('## Job #1');
    expect(result).toContain('```');
  });

  it('commentLanguageがプロンプトに含まれる', () => {
    const result = buildReportRewriteUserPrompt(baseInputs);

    expect(result).toContain('Japanese');
  });
});

describe('reportRewriteAgent', () => {
  it('正しいIDが設定されている', () => {
    expect(reportRewriteAgent.id).toBe('report-rewrite-agent');
  });

  it('正しい名前が設定されている', () => {
    expect(reportRewriteAgent.name).toBe('Report Rewrite Agent');
  });
});
