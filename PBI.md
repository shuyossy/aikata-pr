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
- PBI名: mastra workspaceの仕様に合わせた最適化
- ステータス: done
- 背景
  - mastra workspaceを有効化すると次のようなsystemプロンプトが差し込まれる様に見えている（実際にGitLabのCI/CDパイプラインにてジョブを実行した際のログから取得している。`org/div_99408/sak/sak_sample`はプロジェクトのパス）
  ```
  {
    "role": "system",
    "content": "Local command execution. Working directory: \"/builds/org/div_99408/sak/sak_sample\".\n\nLocal filesystem at \"/builds/org/div_99408/sak/sak_sample\". Relative paths resolve from this directory. File access is restricted to this directory."
  }
  ```
  - レビュー用Agentやパイプライン分析用Agentはプロジェクトのフォルダツリーが連携されているが、上記のメッセージが同時に与えられることでフォルダツリーが探索できないと錯覚してしまうのではないか
- 受け入れ基準
  - mastra workspaceの使用をよく確認し、どの様なsystemプロンプトが差し込まれるのか、実際にworkspace提供toolを利用する際は相対パス記法でなければならないのか（例えば、/src/~としていするとエラーになるのか）十分に理解した上で、以下の対応が完了している
    - mastra workspaceのクセを正しく把握した上で、Agentに送信するプロンプトが最適化できている
- 注意事項
  - プロンプトの追加は最小限にとどめること
- 指摘事項（in progressの場合のみ）
