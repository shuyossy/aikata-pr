# Mastra Workspace Tool 出力制限 調査レポート

本ドキュメントは、Mastra の Workspace ツール（`@mastra/core` v1.16.0）が提供するファイル参照系ツールの出力制限メカニズムと、Agent がその制限下で調査を継続するための仕組みを調査・整理したものである。

## 1. 各ツールの出力制限メカニズム

### 1.1 概要

| ツール | デフォルトトークン上限 | 切り詰め方向 | 行制限 | ページネーション手段 |
|--------|----------------------|-------------|--------|---------------------|
| `mastra_workspace_read_file` | 2000 | 末尾から切り詰め（先頭を保持） | なし | `offset`/`limit` パラメータ |
| `mastra_workspace_grep` | 2000 | 末尾から切り詰め（先頭マッチを保持） | 500文字/行, 1000件上限 | `maxCount` パラメータ |
| `mastra_workspace_list_files` | 1000 | 末尾から切り詰め | なし | `maxDepth`/`pattern` パラメータ |
| `mastra_workspace_execute_command` | 2000 | サンドイッチ（10%先頭+90%末尾�� | 200行（tail） | `tail` パラメータ（0=無制限） |

### 1.2 トークンカウント方式

すべてのツールは **tiktoken**（`o200k_base` エンコーディング）によるトークンカウントを使用する。
1トークンは概ね3〜4文字に相当するが、コードの言語や構文によって変動する。

### 1.3 ツール別の切り詰め処理フロー

#### `read_file`

1. ファイル全体を読み込み
2. `offset`/`limit` が指定されていれば、該当行範囲を抽出
3. `showLineNumbers` が true（デフォルト）なら行番号を付与（`     1→content` 形式）
4. ヘッダを付与: `path/file.ts (lines 10-50 of 200, 5000 bytes)` または `path/file.ts (5000 bytes)`
5. `applyTokenLimit(output, tokenLimit, "end")` でトークン制限を適用（末尾を切り詰め）
6. 切り詰め時: `[output truncated: showing first ~N of ~M tokens]` を末尾に付加

#### `grep`

1. ファイルシステムを走査してパターンマッチング
2. 各マッチ行を `filepath:lineNumber:columnNumber: matchedLine` 形式で出力
3. 個別行は500文字で切り詰め
4. グローバル上限1000マッチで打ち切り
5. サマリヘッダを先頭に付加: `N matches across M files`（打ち切り時は `(truncated at 1000)` を付記）
6. `applyTokenLimit(output, tokenLimit, "end")` でトークン制限を適用
7. 切り詰め時: `[output truncated: showing first ~N of ~M tokens]` を末尾に付加

#### `list_files`

1. ディレクトリツリーをタブインデント形式で構築
2. `maxDepth`（デフォルト: 2）で深さ制限
3. `.gitignore` を尊重（デフォルト: true）
4. サマリを付加: `N directories, M files`（深さ制限到達時は `(truncated at depth N)` を付記）
5. `applyTokenLimit(output, tokenLimit ?? 1000, "end")` でトークン制限を適用（デフォルト上限が他ツールより低い）
6. 切り詰め時: `[output truncated: showing first ~N of ~M tokens]` を末尾に付加

#### `execute_command`

1. コマンドを実行
2. `applyTail(output, tail)` で行ベースの切り詰め（デフォルト: 末尾200行を保持）
3. 行切り詰め時: `[showing last N of M lines]` を先頭に付加
4. `applyTokenLimitSandwich(output, tokenLimit)` でトークン制限を適用（先頭10% + 末尾90%を保持）
5. サンドイッチ切り詰め時: `[...output truncated — showing first ~N + last ~M of ~T tokens...]` を中間に挿入
6. ANSI エスケープシーケンスは自動的に除去

## 2. Agent が制限された出力から調査を続ける仕組み

### 2.1 出力に含まれるナビゲーショ���ヒント

Agent が切り詰められた出力を受け取った際に、次のアクションを判断するための情報が各ツールの出力に含まれている。

| ヒントの種類 | 出力例 | 提供元ツール | Agent の利用方法 |
|-------------|--------|-------------|----------------|
| 行番号 | `     1→content` | `read_file` | `offset`/`limit` で次のページを要求 |
| 行範囲ヘッダ | `file.ts (lines 10-50 of 200, 5000 bytes)` | `read_file` | 全体行数から残りの未読範囲を把握 |
| grep 座標 | `src/foo.ts:42:5: const bar = ...` | `grep` | `read_file(path, offset=40, limit=20)` で該当箇所を直接参照 |
| マッチ数サマリ | `25 matches across 8 files` | `grep` | 結果の規模を把握し、必要に応じてパターンを絞り込み |
| 深さ制限通知 | `(truncated at depth 2)` | `list_files` | `maxDepth` を増やすか、特定ディレクトリに絞って再呼び出し |
| トークン切り詰め通知 | `[output truncated: showing first ~2000 of ~5000 tokens]` | 全ツール | まだ見えていないデータの存在と規模を認識 |
| 行切り詰め通知 | `[showing last 200 of 5000 lines]` | `execute_command` | `tail: 0` で全出力を要求、またはコマンドに `head`/`grep` をパイプ |
| ��ンドイッチ通知 | `[...output truncated — showing first ~200 + last ~1800 of ~5000 tokens...]` | `execute_command` | 先頭（ヘッダ/設定情報）と末尾（最終結果/エラー）を両方確認 |

### 2.2 Agent のナビゲーション戦略

Agent は以下の戦略を組み合��せて、制限���れた出力から効率的に調査を進める。

1. **切り詰め通知による状況認識**: すべての切り詰めメカニズムが明示的な通知を出力するため、Agent は「まだ見えていないデータがある」ことを常に認識できる。

2. **`read_file` のページネ���ション**: 行番号とヘッダの全体行数から���`offset`/`limit` を使って未読部分を順次読み込む。
   - 例: ヘッダ `(lines 1-150 of 500)` → 次回 `offset=151, limit=150` で続きを読む

3. **`grep` から `read_file` への遷移**: `grep` の `filepath:lineNumber` 出力を座標として、`read_file` で該当ファイルの関連箇所を直接参照する。
   - 例: `src/foo.ts:42:5: ...` → `read_file("src/foo.ts", offset=35, limit=20)` で前後のコンテキストを取得

4. **`list_files` のディレクトリ深掘り**: 深さ制限やトークン制限で切り詰���られた場合、特定のサブディレクトリに対して `list_files` を再呼び出しする。
   - 例: `list_files("src/mastra", maxDepth=3)` で特定ディレクトリを詳細に探索

5. **`execute_command` のサンドイッチ活用**: 先頭10%（通常はコマンドのヘッダや設定情報）と末尾90%（最終結果やエラー）が保持されるため、全体を読まなくても重要な情報を把握で��る。

## 3. 本アプリ向け最適化

### 3.1 課題

デフォルトのトークン制限では、以下の問題が発生する:

- **`read_file` (2000トークン)**: 一般的なソースファイル（200〜500行）の約100〜150行しか表示できず、頻繁なページネーションが必要
- **`grep` (2000トークン)**: 大規模プロジェクトでの検索結果が切り詰められ、重要なマッチを見逃す可能性
- **`list_files` (1000トークン)**: 中規模以上のプロジェクト構造を把握するには不十分
- **`execute_command` (2000トーク��)**: ビルドログやテスト結果の分析時に出力が不足

### 3.2 最適化設定

`WorkspaceToolsConfig` を使って各ツールの `maxOutputTokens` を本アプリ向けに設定する。

| ツール | デフォルト | 最適化後 | 根拠 |
|--------|-----------|---------|------|
| `read_file` | 2000 | 4000 | 中規模ファイル（200〜300行）をページネーション不要で閲覧可能に |
| `grep` | 2000 | 3000 | 検索結果をより多く取得し、コードパターンの把握効率を向上 |
| `list_files` | 1000 | 2000 | プロジェクト構造の把握に十���なツリー出力を確保 |
| `execute_command` | 2000 | 4000 | ビルドログ・テスト���果の解析に十分な出力を確保 |

設定は `src/mastra/shared/workspaceToolsConfig.ts` に集約し、review / pipeline-report 両エージェントで共有する。
