/**
 * GitLab APIとの通信を行うHTTPクライアント
 * PRIVATE-TOKENヘッダによる認証を自動付与する
 */
export class GitLabApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    // 末尾スラッシュを除去して正規化
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  /**
   * GETリクエストを送信する
   */
  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'PRIVATE-TOKEN': this.token },
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * GETリクエストを送信しプレーンテキストを取得する
   * （例: ジョブトレースなど `text/plain` レスポンス用）
   */
  async getText(path: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'PRIVATE-TOKEN': this.token },
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  /**
   * GETリクエストを送信し生の Response を取得する
   * （例: アーティファクト zip をストリーミング保存する用途）
   * 呼び出し側は `response.body` をストリーム処理する責務を負う。
   */
  async getResponse(path: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'PRIVATE-TOKEN': this.token },
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  /**
   * ページネーション付きGETリクエストを送信する
   * GitLab APIのLinkヘッダを辿って全ページのデータを結合する
   */
  async getAll<T>(path: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?';
    let url: string | null = `${this.baseUrl}${path}${separator}per_page=100`;
    const allItems: T[] = [];

    while (url) {
      const response = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': this.token },
      });
      if (!response.ok) {
        throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
      }
      const items = (await response.json()) as T[];
      allItems.push(...items);

      // Linkヘッダから次ページURLを取得
      url = this.extractNextPageUrl(response.headers.get('link'));
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * PUTリクエストを送信する
   */
  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }
}
