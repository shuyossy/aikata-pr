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
- PBI名: 本プロジェクトで利用するCIパイプラインの強化
- ステータス: done
- 受け入れ基準
  - CIパイプラインでビルドしたチェックロジックをGitLabのRegistryにリリースできている
    - バージョンはsemantic-releaseで検出した環境変数RELEASE_VERSIONを利用
    - source mapも合わせてリリースする（異常事態発生時のデバッグ用）
- 注意事項
  - ユーザに提供するCIテンプレートの方ではないので注意
- 指摘事項（in progressの場合のみ）
