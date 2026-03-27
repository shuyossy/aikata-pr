# 本プロジェクトの概要
本プロジェクトはGitLabのプロジェクトにおいて、チェックリストに沿ったMRのAIレビューを実行するためのCI/CDパイプラインテンプレートを提供するプロジェクトである。
任意のGitLabプロジェクトにおいて、本プロジェクトの`.ci-template/piplines/template.yml`を`.gitlab-ci.yml`上で`include`することで、MRのAIレビューを実行することができる。

# 用語集
@docs/domain/glossary.md

# アプリの開発方針
- TDD
- DDD
  - クリーンアーキテクチャを採用

# 外部設計
## ユビキタス用語集
### エンティティ
`docs/domain/entity.md`
### ビジネスルール
`docs/domain/business_rule.md`
### ユースケース
`docs/domain/usecase.md`

## 環境変数設計
`docs/config/env_val.md`

## 処理フロー概念設計
`docs/archtecture/overallflow_concept.md`

# 内部設計
## アーキテクチャ設計
@docs/archtecture/tech.md
@docs/archtecture/folder_structure.md

# アプリ開発の進め方
  1-1. 設計書の修正
   - 対象: `docs`
  1-2. 振る舞いを確認するための（ブラックボックス）テストを作成
    - 古典派的スタイルで作成
    - 正常系、異常系どちらも作成
    - バックエンドロジックはアプリケーション層、ドメイン層どちらの振る舞いテストも作成
    - インフラ層については、テスト実施ごとに環境を汚染しない（環境を隔離して使い捨てができる、またはそのように振る舞わせることができる）場合はできる限り作成するが、汚染する場合は不要
    - vitestを利用
  2. 1のテストがグリーンになるように実装
  3. リファクタリングとホワイトボックステストを拡充
    - 最終的にテストの条件カバレッジが80%以上となるようにすること

# コマンド
主要なコマンドを追加した場合は、以下に追記すること
```bash
# テスト
npm run test              # テスト実行
npm run test:watch        # テスト（watchモード）
npm run test:coverage     # テスト + カバレッジ

# Lint / Format
npm run lint              # ESLint 実行
npm run lint:fix          # ESLint 自動修正
npm run format            # Prettier フォーマット
npm run format:check      # Prettier フォーマットチェック

# ビルド
npm run build:cli         # CLI用バンドル（dist/index.js）

# 実行
node dist/index.js --user-id <userId> [options]
```

# 作業時の注意点
- クリーンアーキテクチャの中心部分から外側に向けてコーディングを進めること
- Mastraについての注意点
  - **BEFORE doing ANYTHING with Mastra, load the `mastra` skill FIRST.** Never rely on cached knowledge as Mastra's APIs change frequently between versions. Use the skill to read up-to-date documentation from `node_modules`.
  - Register new agents, tools, workflows, and scorers in `src/mastra/index.ts`
  - Use schemas for tool inputs and outputs
  - [Mastra Documentation](https://mastra.ai/llms.txt)
  - [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)
- 決して`node_modules`を直接編集しないこと
- プロジェクト全体を把握して、全ての実装が必要箇所を正しく洗い出してから実装すること
- 既存資源（型、コンポーネント、ヘルパー関数など）を積極的に活用して効率的に実装すること
- 似たような実装内容がある場合は参考にしたり、共通化を検討すること
- TypeScriptを利用して型安全なコードにすること
- プロンプトは英語で記載すること
  - プロンプトの内容は経験豊富なプロンプトエンジニアとしてベストプラクティスに基づいて実装すること
  - 一般的で自然な英語表現にすること
- コードのコメントは日本語で記載すること
- エラーメッセージは英語で記載すること
- eslintについては単純なフォーマットエラーの場合は対応する必要はない
- 最終的にtypescriptの型エラーがないことを確認すること
  - 既存のエラーは対応不要
  - 新規実装した部分にエラーがある場合は対応すること
- 最終的にアプリのビルドエラーやアクセス時エラーがないことを確認すること
- 新規追加や編集した箇所については必ずテストを更新し、最終的に全てのテストがパスすることを確認すること
- 本アプリは最終的に外部ネットワークに繋がらない社内環境で利用するため、CDNなどの利用はしないこと
- このシステムはまだリリースされていないので、コードを変更する際、後方互換製を考慮する必要はない
- デフォルトの環境変数は.env.exampleと`.ci-template/variable/variables.yml`に入れておくこと

# PBI
@PBI.md
