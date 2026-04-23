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
- PBI名: レビュー時suggestに関するprompt改善
- ステータス: done
- 背景
  - 現状は、指定の評定に関するsuggestを必ず登録しようとする
    - suggestはMR diffの範囲内でしか実行できないという制約下で、無理矢理suggestを登録しようとしてしまうので、suggestの品質が悪くなる
- 受け入れ基準
  - suggest登録可能な範囲でsuggestする内容がない場合は、suggestの登録は不要である旨をpromptに明記する
- 注意事項
- 指摘事項（in progressの場合のみ）
