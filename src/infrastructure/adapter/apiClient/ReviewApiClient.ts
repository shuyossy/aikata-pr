/**
 * APIリクエストの型
 */
export interface ReviewApiRequest {
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
    qualityGate?: {
      failureCriteria?: Array<{ ratingLabel: string; threshold: number }>;
    };
  };
  options?: {
    commentLanguage?: string;
    skillsPaths?: string[];
    treeMaxDepth?: number;
    maxContextLength?: number | null;
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
}

/**
 * 進捗イベントの型
 */
export interface ReviewProgressEvent {
  status: string;
  message?: string;
}

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
   */
  async executeReview(
    request: ReviewApiRequest,
    onProgress?: (event: ReviewProgressEvent) => void,
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
            const parsed = JSON.parse(currentData) as Record<string, unknown>;

            switch (currentEvent) {
              case 'progress':
                onProgress?.(parsed as unknown as ReviewProgressEvent);
                break;
              case 'result':
                return parsed as unknown as ReviewApiResponse;
              case 'error':
                throw new Error(
                  `Review API error: ${(parsed.message as string) ?? 'Unknown error'}`,
                );
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
