# ユーザガイド・README整備 設計書

## 背景・目的

aikata-prは社内セルフホストGitLab環境向けのAIレビューツールだが、現状のREADMEはMastraテンプレートのままであり、ユーザガイドも存在しない。導入方法や設定方法、活用方法を文書化することで、チーム横断での導入を促進する。

## 成果物

1. **`docs/guide/user-guide.md`** — ユーザガイド（導入背景〜具体的な導入方法〜活用のヒント）
2. **`README.md`** — ユーザガイドの要約レベル

## 設計方針

- 想定読者: 管理者・開発者を区別せず、1つの流れで記載
- 言語: 日本語
- 対象環境: セルフホストGitLabのみ
- 導入方法: Dockerのみ（npxは案内しない）

## ユーザガイド構成

### 1. aikata-prとは
- 概要: MRに対してAIがチェックリストに沿ったレビューを自動実行するCIテンプレート
- 仕組み: CIテンプレートをinclude → MR作成時に自動レビュー → 結果をディスカッションに投稿
- 処理フロー概要（テキストベースの図）

### 2. 前提条件
- セルフホストGitLab + Docker executor対応のRunner
- AIモデルのAPIエンドポイント（OpenAI互換）
- GitLab APIトークン（apiスコープ）

### 3. 導入手順
- 3.1 CIテンプレートの設定（.gitlab-ci.ymlへのinclude記述例）
- 3.2 CI/CD変数の設定（必須/任意の一覧表付き）
- 3.3 チェックリストファイルの作成（CSV形式、サンプル付き）
- 3.4 レビュー設定ファイルの作成（任意、JSON形式、サンプル付き）

### 4. 設定リファレンス
- 4.1 環境変数一覧（カテゴリ別テーブル: AI設定、GitLab設定、入力ファイル、動作設定）
- 4.2 チェックリスト仕様（フォーマット・制約・サンプル）
- 4.3 レビュー設定仕様（JSONスキーマ・各フィールド説明・デフォルト値・カスタマイズ例）
- 4.4 無効化（AIKATA_PR_DISABLED=true）

### 5. レビュー結果の見方
- 5.1 コメント構成と評定ラベルの意味
- 5.2 リトライの挙動（同一コミット/新コミット/コメント削除時）

### 6. 活用のヒント
- コードレビューの標準化（チーム共通のチェック観点を定義）
- ドキュメントの品質チェック（git管理されたドキュメント更新時に自動チェック）
- 設計書とコードの整合性チェック（コード修正時に設計書との乖離を検出）
- その他の応用例

### 7. トラブルシューティング
- よくあるエラーと対処法

## README.md構成
- プロジェクト名 + 一行説明
- 特徴（箇条書き3-4個）
- クイックスタート（最小構成の設定例）
- 詳細はユーザガイドへのリンク

## 情報ソース

ドキュメント作成時に参照すべき既存ファイル:

| 情報 | ファイルパス |
|------|-------------|
| 環境変数一覧 | `docs/config/env_val.md` |
| CIテンプレート | `.ci-template/piplines/template.yml` |
| テンプレート変数デフォルト | `.ci-template/variable/variables.yml` |
| ドメインエンティティ | `docs/domain/entity.md` |
| ビジネスルール | `docs/domain/business_rule.md` |
| 処理フロー概念 | `docs/archtecture/overallflow_concept.md` |
| チェックリストパーサ | `src/application/shared/parser/ChecklistParser.ts` |
| レビュー設定パーサ | `src/application/shared/parser/ReviewSettingsParser.ts` |
| CLIオプション定義 | `src/index.ts` |
| .env.example | `.env.example` |
