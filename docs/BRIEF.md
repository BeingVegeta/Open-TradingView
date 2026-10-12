# Build brief: Open-TradingView (realtime charting on Zerodha Kite Connect)

> The original brief for this project, as given at the start of development on 11 October 2026,
> kept verbatim: only this note, heading markup and paragraph breaks were added. Where the build
> deviates from it, see [DECISIONS.md](DECISIONS.md).

You are building a self-hosted, TradingView-style charting app for Indian markets in the repo `https://github.com/BeingVegeta/Open-TradingView.git`. The repo is empty, so you are setting up the project from scratch. Market data comes from Zerodha's Kite Connect v3 API.

The user is a single trader running this on their own machine with their own Kite Connect API key. That shapes several decisions below, so keep it in mind: one user, one API key, one backend process, a browser on localhost.

## What "done" looks like for v1

A person runs one command, logs in with Zerodha once, searches for any instrument (say `NSE:RELIANCE` or `NIFTY 50`), and gets a candlestick chart with history that keeps updating tick by tick while the market is open. They can change timeframe, scroll back to load older candles, keep a watchlist with live prices, and add a few indicators. It should feel fast and look like a serious dark-theme trading terminal.

Out of scope for v1: placing or modifying orders, alerts, scripting (Pine-like), multi-user accounts, public hosting. Keep the app strictly read-only against Kite; do not call any order endpoints.

## Facts about Kite Connect you must design around

I checked these against the official docs on 11 Oct 2026. Re-read the docs before implementing each piece; every docs page is available as Markdown by appending `index.md`, for example `https://kite.trade/docs/connect/v3/websocket/index.md`. If the docs disagree with this brief, trust the docs and tell me.

### Auth

* Login is a redirect flow: send the user to `https://kite.zerodha.com/connect/login?v=3&api_key=...`, receive `request_token` on the registered redirect URL, then POST it to `/session/token` with `checksum = SHA-256(api_key + request_token + api_secret)` to get an `access_token`.
* All REST calls need `X-Kite-Version: 3` and `Authorization: token api_key:access_token`.
* The access token expires at 6 AM IST the next day, and individual users get no refresh token. A daily manual login is unavoidable, so make it a one-click experience and make expiry a normal app state rather than an error. A `403 TokenException` means: drop the session and show the login prompt.
* `api_secret` and `access_token` must never reach the browser. This is why a backend is required.

### Live data (WebSocket)

* Endpoint: `wss://ws.kite.trade?api_key=...&access_token=...`. Limits: 3,000 instruments per connection, 3 connections per API key.
* Subscribe with JSON `{a:"subscribe", v:[tokens]}`, set mode with `{a:"mode", v:["full",[tokens]]}`. Modes: `ltp` (8 bytes), `quote` (44), `full` (184, includes timestamps, OI and 5-level depth). Index packets are shorter (28 or 32 bytes) and carry no volume.
* Market data frames are binary and may bundle many packets; text frames are JSON (order updates, errors, broker messages); a 1-byte frame is a heartbeat.
* Prices arrive as integers in paise (divide by 100; currency segments use a different divisor).
* Only `full` mode carries the exchange timestamp and last-trade time. Use `full` for instruments on an open chart and `ltp` or `quote` for watchlist rows.
* Ticks are throttled snapshots, not every trade. Volume in a tick is the cumulative day volume, so a candle's volume is the difference in cumulative volume across that candle, not a sum of ticks.

### Historical candles

* `GET /instruments/historical/:instrument_token/:interval?from=...&to=...` with `from`/`to` as `yyyy-mm-dd hh:mm:ss`. Intervals: `minute`, `3minute`, `5minute`, `10minute`, `15minute`, `30minute`, `60minute`, `day`. Add `oi=1` for open interest, `continuous=1` for day candles across expired futures.
* Response rows are `[timestamp, open, high, low, close, volume]`, timestamps in `+0530`, stamped at candle open. The last row during market hours is the still-forming candle.
* Each request is capped by date range. Zerodha staff gave these caps on the forum (not in the docs, so treat as configurable and handle the `InputException` if they've changed): minute 60 days; 3/5/10minute 100; 15/30minute 200; 60minute 400; day 2000.
* There is no native weekly, monthly, 2h or 4h interval. Build those by aggregating on the server.

### Instruments

* `GET /instruments` returns a large gzipped CSV of every tradable instrument (token, tradingsymbol, name, expiry, strike, tick_size, lot_size, instrument_type, segment, exchange). It is regenerated once a day; fetch it once per day (around 08:30 IST) and store it locally.
* Use `exchange:tradingsymbol` as your stable key. Numeric `instrument_token`s get reused for derivatives after expiry, so never key cached candles on the token alone.

### Rate limits

* Quote endpoints 1 req/s, historical 3 req/s, everything else 10 req/s; over the limit returns `429`. Put one rate-limited queue in front of all Kite REST calls.

### Account and policy

* Market data needs the paid Connect plan (₹500/month per API key). The free Personal plan returns no live or historical data. If data calls fail with a permission error, surface that clearly instead of retrying.
* There is no sandbox, and markets are closed evenings and weekends (NSE equity trades 09:15 to 15:30 IST). You will usually be developing with no live ticks. See the mock feed requirement below.
* Zerodha's terms forbid redistributing API market data to other people. Bind the server to localhost by default, do not add multi-user features, and do not commit recorded market data to the repo.

## Architecture

Use TypeScript end to end in a small monorepo, so tick, candle and instrument types are shared:
* `apps/server`: Node (current LTS) with Fastify. Use the official `kiteconnect` npm SDK for REST and its `KiteTicker` for the stream rather than writing your own binary parser; check its current version and API first. SQLite (via `better-sqlite3`) for the instrument master, candle cache, watchlists and the current session.
* `apps/web`: React + Vite. Charts with TradingView's open-source Lightweight Charts (latest major version; read its docs, since the API changed between majors, and keep its attribution on as the licence requires). Zustand or similar for state.
* `packages/shared`: types and the candle aggregation logic, which both sides and the tests use.

Data flow: the server holds the single upstream Kite ticker connection and reference-counts subscriptions across browser tabs. Browsers talk only to the server: REST for instrument search and history, one WebSocket for live updates. The server builds candles from ticks and pushes candle updates for the timeframe each chart is showing, plus raw LTP for watchlists. Coalesce pushes to roughly 4 to 10 per second per chart; the eye can't use more.

If you believe a different stack is clearly better, say so before writing code and wait for my answer. Otherwise use this one.

## The parts that are easy to get wrong

Spend your care here; the rest is routine.
1. Candle boundaries. Intraday candles are anchored to the session open, not to the clock hour: NSE 60-minute candles start 09:15, 10:15, and so on. Work in IST explicitly, never the machine's local timezone (the user is not in India). Confirm the anchoring per exchange by looking at real historical responses rather than assuming, since MCX and currency sessions differ.
2. Stitching history to live. On chart load: fetch history, then apply ticks to the last candle. A live-built candle and Kite's historical candle for the same period can differ slightly, so after each candle closes, and after any reconnect, re-fetch the recent range and reconcile. No gaps and no duplicate bars after a network drop.
3. Ticks outside the session. Pre-open and post-close ticks arrive but don't belong in regular candles. Compare against historical data to decide what to drop.
4. Chart time axis. Lightweight Charts treats timestamps as UTC. Make the axis and crosshair show IST.
5. Lazy loading older data. When the user scrolls left, fetch the next chunk within the per-interval range cap, through the rate-limited queue, and cache it. Requests for a range with no data (holidays, before listing) must terminate, not loop.
6. Reconnects. Upstream drops, browser tab sleeps, and the 6 AM token expiry should each recover or prompt cleanly. Resubscribe and restore modes after reconnecting.

## Mock feed (build this early)

Add a `KITE_MODE=mock` setting where the server uses a fake provider behind the same interface as the real one: a small generated instrument list, synthetic history, and a tick generator that follows the real tick shape (cumulative volume, timestamps, session hours with an option to run "as if the market is open"). Also add a recorder that saves real ticks to a local, git-ignored file and a replayer for them. All automated tests and most UI work run against mock mode; this is the only way to verify realtime behaviour when the market is closed.

## Milestones

Work in this order and stop after each one with a short summary of what works, what you verified and how, and anything you're unsure of.
1. Skeleton and auth. Monorepo, lint, typecheck, test runner, `.env.example` (`KITE_API_KEY`, `KITE_API_SECRET`, redirect URL, mode), README with setup steps including how to register the redirect URL in the Kite developer console. Login flow, session persisted until expiry, logout.
2. Instruments and history. Daily instrument sync, fast search (symbol, name, exchange and type filters, sensible ranking so `RELIANCE` on NSE beats obscure matches), history endpoint with chunking, cache and rate limiting. Chart renders candles and volume, timeframe switcher, scroll-back loading.
3. Realtime. Mock provider, ticker manager, candle builder, browser WebSocket, live-updating last candle, reconciliation, connection status indicator.
4. Terminal features. Watchlist with live LTP and change percent, persisted. Indicators computed in `packages/shared` (SMA, EMA, VWAP, Bollinger Bands, RSI, MACD) with separate panes where appropriate. Crosshair OHLC legend. Market depth panel and OI for derivatives when in `full` mode. Layout and last symbol restored on reload.
5. Polish. Custom timeframes via aggregation (2h, 4h, week, month), multi-chart layout, basic drawing tools (horizontal line, trendline), keyboard symbol search, empty and error states.

## How to verify your work

* Unit-test the candle builder thoroughly with hand-written tick sequences: boundary ticks, cumulative-volume deltas, the day's first tick, index instruments with no volume, a gap followed by reconciliation, each timeframe's anchoring.
* Test the history chunker against the range caps and the rate limiter against its limits with a fake clock.
* Run the app in mock mode and look at it in a browser before calling a milestone done. Type checks and passing tests don't show whether a chart is right.
* When I can supply live credentials during market hours, compare a few closed candles from the app against Kite's own chart for the same instrument and report any mismatch.

## Working agreements

* Never commit secrets, tokens or recorded market data. `.env` and data files are git-ignored from the first commit.
* Ask me for credentials when you need a live check; don't try to work around the login flow or automate the Zerodha login page.
* Small, descriptive commits per logical change. Keep the README current as the setup changes.
* When something in this brief turns out wrong or a Kite behaviour surprises you, tell me what you found rather than quietly working around it.
* Design the UI in the spirit of a pro trading terminal, but don't copy TradingView's logo, name or assets in the interface.
