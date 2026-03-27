import { MrContext } from '../../../../domain/mrContext/index.js';

/**
 * MR情報を取得するためのゲートウェイインターフェース
 */
export interface MrGateway {
  getMrContext(projectId: string, mrIid: string): Promise<MrContext>;
  getCommitsSince(projectId: string, mrIid: string, sinceCommitHash: string): Promise<string[]>;
  getDiffSince(
    projectId: string,
    mrIid: string,
    sinceCommitHash: string,
    currentCommitHash: string,
  ): Promise<string>;
}
