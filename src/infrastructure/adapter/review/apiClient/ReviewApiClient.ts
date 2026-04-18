/**
 * APIリクエストの型
 */
export interface ReviewApiRequest {
  /** 本テンプレートを実行したユーザID（通常は$GITLAB_USER_LOGIN）。APIサーバー側でログに記録される */
  userId: string;
  gitlabToken: string;
  projectId: string;
  mrIid: string;
  checklist: string[];
  reviewSettings?: {
    additionalInstructions?: string;
    concurrentReviewCount?: number | null;
    commentFormat?: string;
    ratings?: Array<{ label: string; definition: string }>;
    hiddenRatingLabels?: string[];
    suggestEnabledRatingLabels?: string[];
    qualityGate?: {
      failureCriteria?: Array<{ ratingLabel: string; threshold: number }>;
    };
  };
  options?: {
    commentLanguage?: string;
    skillsPaths?: string[];
    treeMaxDepth?: number;
  };
}

/**
 * APIレスポンスの型（resultイベントのデータ）
 */
export interface ReviewApiResponse {
  results: Array<{
    checkItemContent: string;
    ratingLabel: string;
    ratingDefinition: string;
    comment: string;
    isError: boolean;
    errorMessage?: string;
  }>;
  commitHash: string;
  commitMessage: string;
  /** 変更提案一覧（APIサーバーからの応答に含まれる） */
  suggestions: Array<{
    checkItemContent: string;
    filePath: string;
    originalCode: string;
    suggestedCode: string;
    comment: string;
    newLine: number;
    linesAbove: number;
    linesBelow: number;
    oldPath: string;
    newPath: string;
  }>;
  /** 解決すべき旧suggestディスカッション */
  suggestResolveEntries: Array<{ discussionId: string; reason: string }>;
  /** MRのdiff_refs.base_sha */
  baseSha: string;
  /** MRのdiff_refs.head_sha */
  headSha: string;
  /** MRのdiff_refs.start_sha */
  startSha: string;
}

/**
 * 進捗イベントの型
 */
export interface ReviewProgressEvent {
  status: string;
  message?: string;
}

/** APIサーバーがレスポンスヘッダで返すリクエストID用ヘッダ名 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * CLI→APIサーバー間のSSEクライアント
 * Node.js組み込みのfetchを使用してAPIサーバーのレビューエンドポイントを呼び出し、
 * SSEレスポンスストリームをパースする
 */
export class ReviewApiClient {
  private readonly apiUrl: string;
  private readonly jwtToken: string;

  constructor(apiUrl: string, jwtToken: string) {
    this.apiUrl = apiUrl;
    this.jwtToken = jwtToken;
  }

  /**
   * レビューAPIを呼び出し、SSEレスポンスを処理する
   *
   * @param request - レビューリクエスト
   * @param onProgress - 進捗イベントを受け取るコールバック
   * @param onRequestId - APIサーバーが返した`X-Request-Id`ヘッダを受け取るコールバック
   *   （ストリーム消費開始前に同期的に呼び出される。呼び出し側はこのIDをログに付与し、
   *   サーバー側ログとの相関キーとして利用する）
   */
  async executeReview(
    request: ReviewApiRequest,
    onProgress?: (event: ReviewProgressEvent) => void,
    onRequestId?: (requestId: string) => void,
  ): Promise<ReviewApiResponse> {
    const url = `${this.apiUrl}/api/v1/review`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.jwtToken}`,
      },
      body: JSON.stringify(request),
    });

    // X-Request-Idヘッダの抽出（エラー応答でも付与される想定のため、!response.okより先に取得）
    const requestId = response.headers.get(REQUEST_ID_HEADER);
    if (requestId && onRequestId) {
      onRequestId(requestId);
    }

    // 非SSEエラー（400, 401, 500等）
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API request failed with status ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error('Response body is empty');
    }

    // SSEストリームをパース
    return this.parseSSEStream(response.body, onProgress);
  }

  /**
   * SSEストリームをパースしてレビュー結果を返す
   */
  private async parseSSEStream(
    body: ReadableStream<Uint8Array>,
    onProgress?: (event: ReviewProgressEvent) => void,
  ): Promise<ReviewApiResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最後の不完全な行をバッファに保持
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6);
        } else if (line === '') {
          // 空行 = イベント区切り
          if (currentEvent && currentData) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(currentData) as Record<string, unknown>;
            } catch {
              throw new Error(
                `Failed to parse SSE event data for event "${currentEvent}": ${currentData}`,
              );
            }

            switch (currentEvent) {
              case 'progress':
                onProgress?.(parsed as unknown as ReviewProgressEvent);
                break;
              case 'result':
                return parsed as unknown as ReviewApiResponse;
              case 'error':
                throw new Error(`Review API error: ${(parsed.error as string) ?? 'Unknown error'}`);
              case 'keepalive':
              case 'done':
                // 無視
                break;
            }
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }

    throw new Error('SSE stream ended without result event');
  }
}
