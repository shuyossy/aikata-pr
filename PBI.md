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
- PBI名: GITLAB_TOKENを利用しない様にする
- ステータス: done
- 背景
  - 環境変数GITLAB_TOKENは他のCI/CDパイプラインで制御するトークンなので、これに依存すると将来的に不具合につながりうる
- 受け入れ基準
  - GITLAB_TOKENではなく、AIKATA_PR_GITLAB_TOKENというトークンでAPIにアクセスするなどの制御を実行する様に変更されている
    - システム内部はgitlab tokenのままで良いが、外部から呼び出す場合は環境変数やオプションをaikata pr gitlab tokenにしてほしい
- 注意事項
- 指摘事項（in progressの場合のみ）

# ID: 2
- PBI名: 全てのチェックリストがエラーの場合の挙動変更
- ステータス: done
- 受け入れ基準
  - レビュー実行した結果、全てのチェックリストのレビューがエラーで失敗していた場合は、ジョブが失敗として終了する
- 注意事項
- 指摘事項（in progressの場合のみ）

