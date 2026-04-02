# PBI #1 MR diff圧縮改善 - 設計書

## 概要

MR diff圧縮アルゴリズムにPhase 2（行数ベースの段階的圧縮）を追加し、超大ファイルでも閾値まで圧縮できるようにする。

## 問題

- 現在のアルゴリズムは`minKeepPercent=5%`が圧縮下限
- 超大ファイル（例: 10,000行）では5%時点で上500行+下500行=1,000行が残る
- AIモデルのコンテキスト長閾値を超える場合がある
- 切り詰め可能な最小単位は先頭行（`diff --git a/... b/...`）まで

## 方針

Phase 1（現状の%ベース圧縮）完了後にPhase 2（行数ベースの段階的圧縮）を追加。

## 圧縮フロー（改善後）

```
Phase 1（既存・変更なし）: keepPercent 30% -> 25% -> ... -> 5%
  | まだ閾値超過
  v
Phase 2（新規）: keepLines半減ループ
  最大ファイルを選択 -> keepLinesを半減 -> 圧縮 -> 閾値チェック
  例: 10000行ファイル
  500行 -> 250行 -> 125行 -> 62行 -> 31行 -> 15行 -> 7行 -> 3行 -> 1行 -> 0(ヘッダーのみ)
  ※各ステップで閾値チェック、到達次第終了
  ※全ファイルがheader-only(keepLines=0)に達したらベストエフォートで終了
```

## 変更対象ファイル

### 1. `src/application/shared/diffCompression/DiffCompressor.ts`

#### 新関数: `compressFileDiffByLines`

```typescript
export function compressFileDiffByLines(
  fileDiff: string,
  keepLines: number,
): { compressed: string; omitted: string }
```

- `keepLines >= 1`: 先頭keepLines行 + 末尾keepLines行を保持、中間を省略マーカーで置換
- `keepLines === 0`: diff --gitヘッダー行（1行目）のみ保持、2行目以降を全て省略
- `keepLines * 2 >= totalLines` の場合: 圧縮不要（そのまま返す）
- 省略マーカーは既存の`compressFileDiff`と同一フォーマット

#### `compressDiffIfNeeded`にPhase 2ループ追加

Phase 1の`while(true)`ループ後、ベストエフォートreturnの前にPhase 2ブロックを挿入。

Phase 2の動作:
1. Phase 1完了時の各ファイルのkeepLinesを算出（`Math.floor(totalLines * minKeepPercent / 100)`）
2. whileループで最大ファイルを選択
3. keepLinesを半減（`Math.floor(currentKeepLines / 2)`）
4. `compressFileDiffByLines(originalFileDiff, newKeepLines)`で圧縮
5. 閾値チェック、到達次第終了
6. 全ファイルがkeepLines=0に達したらベストエフォートで終了

### 2. `src/application/shared/diffCompression/index.ts`

`compressFileDiffByLines`をエクスポートに追加。

### 3. `src/application/shared/diffCompression/__tests__/DiffCompressor.test.ts`

テスト追加（TDDスタイル）。

## 変更不要ファイル

- `getDiffDetail.ts` -- omittedFileDiffsのインターフェース不変
- `ExecuteReviewService.ts` -- 呼び出しインターフェース・オプション不変
- `FolderTreeStripper.ts` -- 無関係
- `DiffCompressionOptions` -- 新オプション不要（Phase 2は自動的に開始）

## テスト計画

### `compressFileDiffByLines`のユニットテスト

1. keepLines=3で上位3行と下位3行を保持する
2. keepLines=1で上位1行と下位1行を保持する
3. keepLines=0でdiff --gitヘッダー行のみ保持する
4. keepLines=0で1行のみのdiffの場合は圧縮不要
5. keepLines * 2 >= totalLinesの場合は圧縮不要
6. 省略マーカーのフォーマットが既存と一致する

### Phase 2統合テスト

7. Phase 1の5%で閾値以下になる場合、Phase 2は実行されない（既存テストで担保）
8. Phase 1の5%では不十分で、Phase 2のkeepLines半減で閾値以下になる場合
9. Phase 2で複数ファイルがある場合、最大ファイルから順に圧縮される
10. Phase 2で全ファイルがkeepLines=0に達してもベストエフォートで完了する
11. Phase 2の結果がomittedFileDiffsに正しく反映される
