import path from 'node:path';
import { buildApp } from './app';
import { ConfigError, isLoopbackHost, loadDotEnv, readConfig } from './config';
import { openDb } from './db';
import type { KiteGateway } from './kite/gateway';
import { LiveKiteGateway } from './kite/liveGateway';
import { MarketClock, marketOpenStart } from './kite/marketClock';
import { MockKiteGateway } from './kite/mockGateway';
import { LocalTickerServer } from './mock/localTickerServer';
import { isMockTradingDay } from './mock/synth';
import { loadRecording, ReplayProducer, TickRecorder } from './ticker/recorder';

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
let gateway: KiteGateway;
let marketClock: MarketClock;
let recorder: TickRecorder | null = null;
if (config.mode === 'mock') {
  const start =
    config.mockStart ??
    (config.mockMarketOpen ? marketOpenStart(Date.now(), isMockTradingDay) : Date.now());
  marketClock = new MarketClock(start, config.mockSpeed);
  const mock = new MockKiteGateway({ latencyMs: config.mockLatencyMs, clock: marketClock });
  await mock.start();
  gateway = mock;
} else {
  const live = new LiveKiteGateway(config);
  marketClock = new MarketClock();
  if (config.replayFile) {
    // Replay recorded ticks through a local Kite-protocol server; history still comes from Kite.
    const ticks = await loadRecording(config.replayFile);
    if (!ticks.length) throw new Error(`No ticks in ${config.replayFile}`);
    const producer = new ReplayProducer(ticks);
    marketClock = new MarketClock(producer.startsAt, config.mockSpeed);
    const server = new LocalTickerServer({ producer, clock: marketClock, isValid: () => true });
    await server.listen();
    live.tickerOverride = (token) => server.url(config.apiKey, token);
  } else if (config.recordTicks) {
    recorder = new TickRecorder(path.join(config.dataDir, 'recordings'));
  }
  gateway = live;
}
const { server, sync } = await buildApp({
  config,
  db,
  gateway,
  marketClock,
  ...(recorder
    ? { onTickerFrame: (d: Buffer, b: boolean, t: number) => recorder.write(d, b, t) }
    : {}),
});
if (!isLoopbackHost(config.host)) {
  server.log.warn(
    `HOST=${config.host} exposes this server beyond this machine. Zerodha's terms forbid ` +
      'redistributing market data; keep it on localhost unless you know what you are doing.',
  );
}

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down`);
  await server.close();
  await gateway.close?.();
  recorder?.close();
  db.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await server.listen({ host: config.host, port: config.port });
sync.start();
if (marketClock.speed !== 1 || Math.abs(marketClock.now() - Date.now()) > 60_000) {
  server.log.info(
    `Market clock: ${new Date(marketClock.now()).toISOString()} at ${marketClock.speed}x (${config.replayFile ? 'replay' : 'mock'})`,
  );
}
server.log.info(
  `Open-TradingView server (${config.mode} mode) on http://${config.host}:${config.port}, ` +
    `Kite redirect URL: ${config.redirectUrl}`,
);
