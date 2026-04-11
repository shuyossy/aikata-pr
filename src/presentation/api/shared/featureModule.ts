import type { Env, Hono } from 'hono';

/**
 * APIサーバに機能ルートを登録するためのモジュール記述子インターフェース。
 * 各機能はこの形に従うモジュールをexportし、`src/server.ts` の `apiFeatures`
 * 配列に追加されるだけで新機能として登録できる。
 *
 * - `TEnv`: Honoのenv型（Variables/Bindings）。機能ごとに固有の型を当てて良い
 * - `register(app)`: 機能のルートをappに登録する。depsはHonoコンテキスト経由で
 *    リクエストハンドラに流れるため、ここでは受け取らない（`createApp` の
 *    `c.set('reviewHandlerDeps', deps)` ミドルウェアが担う）
 */
export interface ApiFeatureModule<TEnv extends Env = Env> {
  name: string;
  register: (app: Hono<TEnv>) => void;
}
