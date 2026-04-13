import type { CliFeatureModule } from '../dispatch.js';

// serverサブコマンド: APIサーバーを起動する
export const serverCliModule: CliFeatureModule = {
  name: 'server',
  description: 'Start the API server',
  run: async (): Promise<void> => {
    // dist/server.js を動的importし、CLIバンドルの肥大化を防ぐ
    const serverPath = new URL('./server.js', import.meta.url).href;
    const { startServer } = await import(serverPath);
    await startServer();
  },
};
