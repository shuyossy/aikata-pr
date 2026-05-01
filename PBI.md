雛形

```
# ID:
- PBI名:
- ステータス: [to do/in progress/done]
- ユーザストーリー/背景
- 受け入れ基準
- 注意事項
- 指摘事項（in progressの場合のみ）
```

# ID: 1
- PBI名: APIサーバが認識するGitLab API URLを動的に指定できるようにする
- ステータス: done
- 背景
  - 複数のセルフホストGitLabに本テンプレートを導入する予定
  - つまり、GitLabのURLは一意に定まらない
  - CLIクラインアント側からGitLabのURLを連携する必要がある
- 受け入れ基準
  - CLIクラインアント側からGitLabのURLを連携できている
  - 横展開として、複数のセルフホストGitLabに対して一つのAPIサーバのみで対応できるか、GitLab API以外にも問題点はないか徹底的に確認できている
- 注意事項
  - マルチGitLabインスタンス対応の監査結果（受入基準#2）:
    - 🔴 **JWT認証の issuer 固定**: `JWT_ISSUER` / `JWT_JWKS_URL` がサーバ起動時 env で1組のみ。複数GitLab対応時は **JWT認証を無効化** して運用するか、別途PBIで対応する必要がある（候補: issuerリスト受付 / JWTの`iss`から動的JWKS解決 / リクエスト由来`gitlabApiUrl`との照合）。`src/server.ts:228-244`、`src/infrastructure/adapter/auth/JwtAuthMiddleware.ts:55-77`
    - 🟡 **レートリミッターのGitLabインスタンス未分離**: バケットキーが`projectId`のみのため、別GitLabの同一projectIdが同じバケットを共有する。AI APIレート制御目的のみで動作上の支障はなし。要対応の場合は`(gitlabApiUrl, projectId)`の合成キーへ。`src/infrastructure/adapter/rateLimiter/RateLimiter.ts`
    - 🟡 **Mastra `WorkflowRequestContext` に gitlabApiUrl 未含有**: 現状ツールがGitLab APIを直接呼ばないため問題なし。ワークフロー内ツールからGitLab API呼び出しを追加する場合は`src/mastra/shared/requestContext.ts`に追加要。
    - 🟢 安全箇所: `CloneManager`/`GitLabApiClient`/Logger/HTTP Gateway層は per-request で安全。
- 指摘事項（in progressの場合のみ）
