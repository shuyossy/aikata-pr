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
- PBI名: MR diffの取得をAPIではなく、gitローカルリポジトリ経由とする
- ステータス: to do
- 背景
  - MR diffについて、API経由で取得すると、diffの内容が多いと省略されてしまう場合がある等不安定
    - 第一にgitローカルリポジトリ経由として、失敗した場合にAPI経由としたい
- 受け入れ基準
  - 第一にgitローカルリポジトリ経由でMR diffを取得できている
    - CI/CDパイプライン環境でも完全なMR diffが取得できる
  - gitローカルリポジトリからの取得が失敗した場合、API経由にフォールバックされている
    - `/projects/:id/merge_requests/:merge_request_iid/changes?access_raw_diffs=true`でdiffを取得する
  - gitローカルリポジトリもAPI経由も失敗した場合は、チェックロジックの失敗として終了している
- 注意事項
- 指摘事項（in progressの場合のみ）
