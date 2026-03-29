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
- PBI名: Open AIのモデルが利用された場合に、reasoning errorのオプションを指定できる
- ステータス: to do
- 受け入れ基準
  - OPENAI_REASONING_EFFORTという環境変数を登録できる様にする
    - この環境変数が指定された場合、REASONING_EFFORTが設定できるモデルであるとみなし、`generate`実行時のオプションを以下の様に指定する
    ```
    {
      temperature: 1,
      providerOptions: {
        openai: {
          reasoningEffort:
            process.env.OPENAI_REASONING_EFFORT,
        },
      },
    }
    ```
- 注意事項
- 指摘事項（in progressの場合のみ）
