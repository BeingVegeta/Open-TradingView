import { buildApp } from './app';
import { ConfigError, isLoopbackHost, loadDotEnv, readConfig } from './config';
import { openDb } from './db';
import type { KiteGateway } from './kite/gateway';
import { LiveKiteGateway } from './kite/liveGateway';
import { MockKiteGateway } from './kite/mockGateway';

loadDotEnv();

let config;
try {
  config = readConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\nConfiguration error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const db = openDb(config.dataDir);
const gateway: KiteGateway =
  config.mode === 'mock'
    ? new MockKiteGateway({ latencyMs: config.mockLatencyMs })
    : new LiveKiteGateway(config);
const { server, sync } = await buildApp({ config, db, gateway });

if (!isLoopbackHost(config.host)) {
  server.log.warn(
    `HOST=${config.host} exposes this server beyond this machine. Zerodha's terms forbid ` +
      'redistributing market data; keep it on localhost unless you know what you are doing.',
  );
}

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down`);
  await server.close();
  db.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await server.listen({ host: config.host, port: config.port });
sync.start();
server.log.info(
  `Open-TradingView server (${config.mode} mode) on http://${config.host}:${config.port}, ` +
    `Kite redirect URL: ${config.redirectUrl}`,
);
