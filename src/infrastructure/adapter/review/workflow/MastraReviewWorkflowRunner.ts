import type {
  ReviewWorkflowRunner,
  ReviewWorkflowParams,
  ReviewWorkflowResult,
} from '../../../../application/shared/port/workflow/index.js';
import { RequestContext } from '@mastra/core/request-context';
import type { WorkflowRequestContext } from '../../../../mastra/shared/requestContext.js';
import { mastra } from '../../../../mastra/index.js';

/**
 * Mastra reviewWorkflowをReviewWorkflowRunnerインターフェースにラップする
 */
export class MastraReviewWorkflowRunner implements ReviewWorkflowRunner {
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

    const requestContext = new RequestContext<WorkflowRequestContext>([
      ['userId', userId],
      ['projectId', projectId],
      ['aiApiKey', aiApiKey],
      ['aiApiEndpointUrl', aiApiEndpointUrl],
      ['aiModelName', aiModelName],
      ['projectDir', projectDir],
      ['openaiReasoningEffort', openaiReasoningEffort],
    ]);

    const workflow = mastra.getWorkflow('reviewWorkflow');
    const run = await workflow.createRun();
    const result = await run.start({ inputData, requestContext });

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
