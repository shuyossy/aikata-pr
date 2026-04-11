# pipeline-report テスト用アーティファクトフィクスチャ

このディレクトリの `sample.zip` は、`ArtifactArchiveReader` のテストで使用するビルド済みのzipである。
テストコード内では動的に生成せず、この pre-built の zip を読み取るだけとする。

## 生成方法

`tools/scripts/gen-test-fixtures.ts` を以下のコマンドで 1 回実行して再生成する:

```bash
npx tsx tools/scripts/gen-test-fixtures.ts
```

このスクリプトは `yazl`（pure JS の zip writer）を使用しており、OS の `zip` コマンドなどの外部プロセス呼び出しには依存しない。

## 中身

`sample.zip` には以下の 2 つのファイルが含まれる:

- `content-a.txt`: `hello world`（UTF-8、11 バイト）
- `content-b.txt`: `binary\x00data`（UTF-8、NUL バイトを含む 11 バイト）
