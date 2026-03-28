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
}
