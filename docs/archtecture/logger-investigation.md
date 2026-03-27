# MastraのPinoLogger再利用可否調査

## 調査対象

- `@mastra/loggers` v1.0.3 の `PinoLogger` クラス
- `@mastra/core` の `MastraLogger` 抽象クラス / `IMastraLogger` インターフェース
- `pino-std-serializers`（pino v10.3.1 の推移的依存）

## PinoLogger の機能

### コンストラクタオプション (`PinoLoggerOptions`)

| オプション | 型 | 説明 |
|---|---|---|
| name | string | ロガー名（デフォルト: "app"） |
| level | LogLevel | ログレベル（デフォルト: INFO） |
| formatters | pino.LoggerOptions['formatters'] | pino の formatters オプション |
| redact | pino.LoggerOptions['redact'] | pino の redact オプション |
| prettyPrint | boolean | pino-pretty の有効/無効（デフォルト: true） |
| transports | Record<string, LoggerTransport> | カスタムトランスポート |
| overrideDefaultTransports | boolean | デフォルトトランスポートの上書き |

### child メソッド

```typescript
child(bindings: Record<string, unknown>): PinoLogger
```

- 追加のバインディング（key-value）を全てのログに含む子ロガーを生成
- 内部的に `pino.Logger.child(bindings)` を呼び出し、新しい `PinoLogger` インスタンスを返す
- `userId` などのコンテキスト情報をバインドするのに適している

### ログメソッド

```typescript
debug(message: string, args?: Record<string, any>): void
info(message: string, args?: Record<string, any>): void
warn(message: string, args?: Record<string, any>): void
error(message: string, args?: Record<string, any>): void
```

- 第1引数: メッセージ文字列
- 第2引数: 追加の key-value ペア（pino の mergingObject に相当）
- 内部的に `this.logger.info(args, message)` の形式で pino を呼び出す

### 制約事項

- 内部の `pino.Logger` インスタンスは `protected` であり、外部から直接アクセスできない
- コンストラクタで `serializers` オプションを pino に渡す仕組みがない（`formatters` と `redact` のみ）
- エラーシリアライザを pino のオプションとして設定するには、直接 pino を使用する必要がある

## pino-std-serializers の利用可能性

- `pino-std-serializers` は pino v10.3.1 の依存として利用可能
- `errWithCause(err: Error): SerializedError` - エラーの cause チェーンを再帰的にシリアライズ
- `node_modules/pino-std-serializers` にインストール済み

## 結論

### PinoLogger を「直接再利用」するか？ → しない

以下の理由から、MastraのPinoLoggerをそのまま利用するのは適切でない:

1. **serializers オプション非対応**: PinoLogger のコンストラクタは pino の `serializers` オプション（`err` シリアライザ等）を渡す機構がない。`errWithCause` をエラーシリアライザとして組み込むことができない。
2. **ログ出力形式の制御が限定的**: `args` オブジェクトの中に `err` キーでエラーを渡しても、pino のデフォルトシリアライザが適用されるだけで `errWithCause` は使われない。

### 採用方針: pino を直接利用

- pino を直接インスタンス化し、`serializers` オプションで `errWithCause` を設定
- `child()` メソッドで `userId` をバインド
- pino-std-serializers は直接依存として追加する（推移的依存に頼らない）
- `pino` は `@mastra/loggers` の依存として既にインストールされているため、追加インストール不要
- ログインターフェースは独自に定義し、pino のインスタンスをラップする
