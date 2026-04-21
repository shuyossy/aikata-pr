import { GitLabApiError } from './GitLabApiError.js';
import { calculateBackoffDelay, sleep } from '../../../lib/rateLimitRetry.js';
import { getLogger } from '../../../lib/logger.js';

/**
 * GitLab APIとの通信を行うHTTPクライアント
 * PRIVATE-TOKENヘッダによる認証を自動付与する
 *
 * リトライ可能なエラー（5xx, 429, ネットワーク障害）発生時は
 * 指数バックオフ + ジッターで最大3回リトライする
 */
export class GitLabApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  /** リトライ最大回数 */
  private static readonly MAX_RETRIES = 3;
  /** バックオフ基本待機時間（ミリ秒） */
  private static readonly BASE_DELAY_MS = 1000;
  /** バックオフ最大待機時間（ミリ秒） */
  private static readonly MAX_DELAY_MS = 10000;

  constructor(baseUrl: string, token: string) {
    // 末尾スラッシュを除去して正規化
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  /**
   * GETリクエストを送信する
   */
  async get<T>(path: string): Promise<T> {
    return this.executeWithRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: { 'PRIVATE-TOKEN': this.token },
        });
        await this.throwIfNotOk(response, 'GET', path);
        return response.json() as Promise<T>;
      },
      'GET',
      path,
    );
  }

  /**
   * GETリクエストを送信しプレーンテキストを取得する
   * （例: ジョブトレースなど `text/plain` レスポンス用）
   */
  async getText(path: string): Promise<string> {
    return this.executeWithRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: { 'PRIVATE-TOKEN': this.token },
        });
        await this.throwIfNotOk(response, 'GET', path);
        return response.text();
      },
      'GET',
      path,
    );
  }

  /**
   * GETリクエストを送信し生の Response を取得する
   * （例: アーティファクト zip をストリーミング保存する用途）
   * 呼び出し側は `response.body` をストリーム処理する責務を負う。
   */
  async getResponse(path: string): Promise<Response> {
    return this.executeWithRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          headers: { 'PRIVATE-TOKEN': this.token },
        });
        await this.throwIfNotOk(response, 'GET', path);
        return response;
      },
      'GET',
      path,
    );
  }

  /**
   * ページネーション付きGETリクエストを送信する
   * GitLab APIのLinkヘッダを辿って全ページのデータを結合する
   * 各ページのリクエストは個別にリトライされる
   */
  async getAll<T>(path: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?';
    let url: string | null = `${this.baseUrl}${path}${separator}per_page=100`;
    const allItems: T[] = [];

    while (url) {
      const currentUrl: string = url;
      const pageResult: { items: T[]; nextUrl: string | null } = await this.executeWithRetry(
        async () => {
          const response = await fetch(currentUrl, {
            headers: { 'PRIVATE-TOKEN': this.token },
          });
          await this.throwIfNotOk(response, 'GET', path);
          const pageItems = (await response.json()) as T[];
          return {
            items: pageItems,
            nextUrl: this.extractNextPageUrl(response.headers.get('link')),
          };
        },
        'GET',
        path,
      );
      allItems.push(...pageResult.items);
      url = pageResult.nextUrl;
    }

    return allItems;
  }

  /**
   * Linkヘッダから次ページのURLを抽出する
   */
  private extractNextPageUrl(linkHeader: string | null): string | null {
    if (!linkHeader) {
      return null;
    }
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }

  /**
   * POSTリクエストを送信する
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const serializedBody = JSON.stringify(body);
    return this.executeWithRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'PRIVATE-TOKEN': this.token,
            'Content-Type': 'application/json',
          },
          body: serializedBody,
        });
        await this.throwIfNotOk(response, 'POST', path, serializedBody);
        return response.json() as Promise<T>;
      },
      'POST',
      path,
    );
  }

  /**
   * PUTリクエストを送信する
   */
  async put<T>(path: string, body: unknown): Promise<T> {
    const serializedBody = JSON.stringify(body);
    return this.executeWithRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: 'PUT',
          headers: {
            'PRIVATE-TOKEN': this.token,
            'Content-Type': 'application/json',
          },
          body: serializedBody,
        });
        await this.throwIfNotOk(response, 'PUT', path, serializedBody);
        return response.json() as Promise<T>;
      },
      'PUT',
      path,
    );
  }

  /**
   * リトライ可能なエラーかどうかを判定する
   *
   * - GitLabApiError: 5xx（サーバーエラー）または 429（レート制限）
   * - TypeError: fetchのネットワーク障害（DNS解決失敗、接続リセット等）
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof GitLabApiError) {
      return error.isServerError || error.status === 429;
    }
    return error instanceof TypeError;
  }

  /**
   * リトライ付きでオペレーションを実行する
   *
   * リトライ可能なエラー発生時は指数バックオフ + ジッターで待機し、
   * 最大 MAX_RETRIES 回リトライする。リトライ不可能なエラーは即座にスローする。
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    method: string,
    path: string,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!this.isRetryableError(error) || attempt >= GitLabApiClient.MAX_RETRIES) {
          throw error;
        }
        const delay = calculateBackoffDelay(
          attempt,
          GitLabApiClient.BASE_DELAY_MS,
          GitLabApiClient.MAX_DELAY_MS,
        );
        try {
          getLogger().warn(
            {
              attempt: attempt + 1,
              maxRetries: GitLabApiClient.MAX_RETRIES,
              delayMs: Math.round(delay),
              method,
              path,
            },
            `GitLab API request failed, retrying after ${Math.round(delay)}ms`,
          );
        } catch {
          // ロガー未初期化時はログ出力をスキップ
        }
        await sleep(delay);
      }
    }
  }

  /**
   * レスポンスがエラーの場合、レスポンスボディを含むGitLabApiErrorをスローする
   */
  private async throwIfNotOk(
    response: Response,
    method: string,
    path: string,
    requestBody?: string,
  ): Promise<void> {
    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      throw new GitLabApiError({
        status: response.status,
        statusText: response.statusText,
        responseBody,
        method,
        path,
        requestBody,
      });
    }
  }
}
