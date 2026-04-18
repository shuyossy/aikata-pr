import type {
  ReviewWorkflowRunner,
  ReviewWorkflowParams,
  ReviewWorkflowResult,
} from '../../../../application/shared/port/workflow/index.js';
import type { SuggestionLineResolver } from '../../../../application/shared/port/suggestion/index.js';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRequestContext } from '../../../../mastra/shared/requestContext.js';
import { mastra } from '../../../../mastra/index.js';
import { DiffBasedSuggestionLineResolver } from '../suggestion/index.js';

/**
 * reviewワークフロー用のRequestContext型
 * WorkflowRequestContextにsuggest行番号リゾルバを追加
 */
interface ReviewRunnerContext extends WorkflowRequestContext {
  suggestionLineResolver: SuggestionLineResolver;
}

/**
 * Mastra reviewWorkflowをReviewWorkflowRunnerインターフェースにラップする
 */
export class MastraReviewWorkflowRunner implements ReviewWorkflowRunner {
  private readonly suggestionLineResolver: SuggestionLineResolver;

  constructor() {
    this.suggestionLineResolver = new DiffBasedSuggestionLineResolver();
  }

  async run(params: ReviewWorkflowParams): Promise<ReviewWorkflowResult> {
    const {
      userId,
      projectId,
      aiApiKey,
      aiApiEndpointUrl,
      aiModelName,
      projectDir,
      openaiReasoningEffort,
      ...inputData
    } = params;

    const requestContext = new RequestContext<ReviewRunnerContext>([
      ['userId', userId],
      ['projectId', projectId],
      ['aiApiKey', aiApiKey],
      ['aiApiEndpointUrl', aiApiEndpointUrl],
      ['aiModelName', aiModelName],
      ['projectDir', projectDir],
      ['openaiReasoningEffort', openaiReasoningEffort],
      ['suggestionLineResolver', this.suggestionLineResolver],
    ]);

    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await run.start({ inputData, requestContext: requestContext as any });

    if (result.status === 'failed') {
      throw new Error(`Workflow failed: ${result.error?.message ?? 'Unknown error'}`, {
        cause: result.error,
      });
    }

    if (result.status !== 'success') {
      throw new Error(`Workflow ended with unexpected status: ${result.status}`);
    }

    return result.result as ReviewWorkflowResult;
  }
}
