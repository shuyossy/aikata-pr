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
- PBI名: 各機能における各ツールのロングコンテキスト出力対応
- ステータス: to do
- 背景
  - 以下ツールについて、ツール出力がロングコンテキストになる可能性があるが、対策できていない
    - レビュー機能
      - `getDiffDetailTool`
    - パイプライン分析機能
      - `getJobLogDetailTool`
- 受け入れ基準
  - 上記toolに`mastra_workspace_read_file`のエッセンスを取り込むこと
    - 出力トークンを絞りつつ、Agentに次の分析のためのヒントを与えて欲しい
- 注意事項
  - mastra workspace提供toolについては`docs/archtecture/workspace-tool-investigation.md`にサマリをまとめているので、参考にすること（ただし、実際にコードも確認すること）
- 指摘事項（in progressの場合のみ）
