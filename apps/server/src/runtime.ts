import path from 'node:path';
import type { ModeInfo, ModeSwitchRequest } from '@otv/shared';
import { buildApp, type App } from './app';
import { isLoopbackHost, readConfig, type Config } from './config';
import { claimDataMode, openDb, type Db } from './db';
import type { KiteGateway } from './kite/gateway';
import { LiveKiteGateway } from './kite/liveGateway';
import { MarketClock, marketOpenStart } from './kite/marketClock';
import { MockKiteGateway } from './kite/mockGateway';
import { LocalTickerServer } from './mock/localTickerServer';
import { isMockTradingDay } from './mock/synth';
import { loadRecording, ReplayProducer, TickRecorder } from './ticker/recorder';

interface Running {
  config: Config;
  app: App;
  db: Db;
  gateway: KiteGateway;
  recorder: TickRecorder | null;
  replay: LocalTickerServer | null;
  clock: MarketClock;
}

export const MOCK_SPEEDS = [1, 2, 5, 10, 30];

/**
 * Owns the running server and can relaunch it in the other mode (live ↔ mock)
 * on the same port, so the UI can switch data sources without a terminal.
 * Each mode has its own data folder. The switch lasts until the process
 * restarts; `pnpm start` always follows .env.
 */
export class Runtime {
  private current: Running | null = null;
  private switching: Promise<void> | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  get liveAvailable(): boolean {
    return !!(this.env.KITE_API_KEY?.trim() && this.env.KITE_API_SECRET?.trim());
  }

  info(): ModeInfo {
    const c = this.current;
    return c
      ? this.infoFor(c.config, c.clock)
      : { mode: 'live', liveAvailable: this.liveAvailable, mock: null };
  }

  private infoFor(config: Config, clock: MarketClock): ModeInfo {
    return {
      mode: config.mode,
      liveAvailable: this.liveAvailable,
      mock:
        config.mode === 'mock'
          ? { marketOpen: config.mockMarketOpen || config.mockStart !== null, speed: clock.speed }
          : null,
    };
  }

  /** Starts with the configuration from the environment (.env). */
  async start(): Promise<Config> {
    const config = readConfig(this.env);
    await this.launch(config);
    return config;
  }

  /** Validates a switch request; returns an error message or null. */
  check(req: ModeSwitchRequest): string | null {
    if (req.mode !== 'live' && req.mode !== 'mock') return 'mode must be "live" or "mock"';
    if (req.mode === 'live' && !this.liveAvailable) {
      return 'Live mode needs KITE_API_KEY and KITE_API_SECRET in .env (then restart).';
    }
    if (req.speed !== undefined && !MOCK_SPEEDS.includes(req.speed))
      return `speed must be one of ${MOCK_SPEEDS.join(', ')}`;
    return null;
  }

  /** Stops the running server and starts it again in the requested mode. */
  switchTo(req: ModeSwitchRequest): Promise<void> {
    if (this.switching) return this.switching;
    const env: NodeJS.ProcessEnv = { ...this.env, KITE_MODE: req.mode };
    if (req.mode === 'mock') {
      env.MOCK_MARKET_OPEN = req.marketOpen === false ? '0' : '1';
      env.MOCK_SPEED = String(req.speed ?? 1);
      delete env.MOCK_START;
    }
    this.switching = (async () => {
      const config = readConfig(env);
      const prev = this.current;
      prev?.app.server.log.info(`Switching to ${req.mode} mode`);
      if (prev) await this.stop(prev);
      try {
        await this.launch(config);
      } catch (err) {
        // Don't leave the user without a server: go back to the previous configuration.
        console.error('Mode switch failed; restoring the previous mode:', err);
        if (prev) await this.launch(prev.config);
        throw err;
      }
    })().finally(() => {
      this.switching = null;
    });
    return this.switching;
  }

  async shutdown(): Promise<void> {
    if (this.current) await this.stop(this.current);
  }

  private async launch(config: Config): Promise<void> {
    const db = openDb(config.dataDir);
    if (claimDataMode(db, config.mode)) {
      console.warn(
        `Data in ${config.dataDir} came from the other mode; cleared cached instruments, candles and session.`,
      );
    }
    let gateway: KiteGateway;
    let clock: MarketClock;
    let recorder: TickRecorder | null = null;
    let replay: LocalTickerServer | null = null;
    if (config.mode === 'mock') {
      const start =
        config.mockStart ??
        (config.mockMarketOpen ? marketOpenStart(Date.now(), isMockTradingDay) : Date.now());
      clock = new MarketClock(start, config.mockSpeed);
      const mock = new MockKiteGateway({ latencyMs: config.mockLatencyMs, clock });
      await mock.start();
      gateway = mock;
    } else {
      const live = new LiveKiteGateway(config);
      clock = new MarketClock();
      if (config.replayFile) {
        // Replay recorded ticks through a local Kite-protocol server; history still comes from Kite.
        const ticks = await loadRecording(config.replayFile);
        if (!ticks.length) throw new Error(`No ticks in ${config.replayFile}`);
        const producer = new ReplayProducer(ticks);
        clock = new MarketClock(producer.startsAt, config.mockSpeed);
        replay = new LocalTickerServer({ producer, clock, isValid: () => true });
        await replay.listen();
        const server = replay;
        live.tickerOverride = (token) => server.url(config.apiKey, token);
      } else if (config.recordTicks) {
        recorder = new TickRecorder(path.join(config.dataDir, 'recordings'));
      }
      gateway = live;
    }
    const rec = recorder;
    const app = await buildApp({
      config,
      db,
      gateway,
      marketClock: clock,
      ...(rec ? { onTickerFrame: (d: Buffer, b: boolean, t: number) => rec.write(d, b, t) } : {}),
      modeControl: {
        info: () => this.infoFor(config, clock),
        check: (req) => this.check(req),
        // Reply first, then restart (the response must leave before the server closes).
        request: (req) => setTimeout(() => void this.switchTo(req).catch(() => {}), 50),
      },
    });
    if (!isLoopbackHost(config.host)) {
      app.server.log.warn(
        `HOST=${config.host} exposes this server beyond this machine. Zerodha's terms forbid ` +
          'redistributing market data; keep it on localhost unless you know what you are doing.',
      );
    }
    await app.server.listen({ host: config.host, port: config.port });
    app.sync.start();
    this.current = { config, app, db, gateway, recorder, replay, clock };
    if (clock.speed !== 1 || Math.abs(clock.now() - Date.now()) > 60_000) {
      app.server.log.info(
        `Market clock: ${new Date(clock.now()).toISOString()} at ${clock.speed}x (${config.replayFile ? 'replay' : 'mock'})`,
      );
    }
    app.server.log.info(
      `Open-TradingView server (${config.mode} mode) on http://${config.host}:${config.port}, ` +
        `Kite redirect URL: ${config.redirectUrl}`,
    );
  }

  private async stop(r: Running): Promise<void> {
    await r.app.server.close();
    await r.gateway.close?.();
    await r.replay?.close();
    r.recorder?.close();
    r.db.close();
    if (this.current === r) this.current = null;
  }
}
