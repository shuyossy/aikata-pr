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

- PBI名: GitLab APIのリトライ考慮
- ステータス: done
- 背景
  - GitLab APIの成功は本システムにとってクリティカルなので、失敗した場合のリトライを考慮する必要がある
- 受け入れ基準
  - GitLab APIの実行に失敗した場合、デフォルトで3回リトライすること
- 注意事項

# ID: 2

- PBI名: CLI（CI/CDジョブ）とAPIサーバのバージョン相違考慮
- ステータス: done
- 背景
  - CLI（CI/CDジョブ）については`include`時の`Ref`でバージョン指定可能
  - APIサーバはデプロイしたバージョンで固定
- 受け入れ基準
  - CLIとAPIサーバでバージョンが相違した場合はエラーとする
    - CLIもAPIサーバも環境変数`AIKATA_PR_VERSION`でバージョンを識別可能とする
- 注意事項
- 指摘事項（in progressの場合のみ）
