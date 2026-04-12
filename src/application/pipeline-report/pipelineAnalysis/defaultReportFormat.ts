/**
 * 全体レポートの骨組み（固定・ユーザカスタマイズ不可）。
 * {{job-sections}} 部分に各ジョブのレポートブロックが並ぶ。
 */
export const OVERALL_REPORT_TEMPLATE = `# パイプライン分析レポート

**パイプライン:** [#{{pipelineId}}]({{pipelineWebUrl}}) — \`{{ref}}\` @ \`{{sha}}\`
**ステータス:** {{pipelineStatus}}
**分析対象ジョブ数:** {{totalTargetJobs}}
**生成時刻:** {{generatedAt}}

---

## サマリ

{{overall-summary}}

### ジョブステータスの内訳

| ステータス | 件数 |
| --- | --- |
{{status-breakdown-rows}}

---

## ジョブ別分析

{{job-sections}}

---

## 推奨アクション

{{recommended-actions}}
`;
