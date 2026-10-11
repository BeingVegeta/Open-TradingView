# Open-TradingView

A self-hosted, realtime charting terminal for Indian markets, running on your own machine
against your own [Zerodha Kite Connect](https://kite.trade/docs/connect/v3/) API key.

- **Single user, localhost only.** One backend process holds your Kite session; your browser
  talks only to it. Zerodha's terms forbid redistributing API market data, so the server binds
  to `127.0.0.1` and has no multi-user features.
- **Read-only.** The app never calls Kite's order endpoints (enforced by a lint rule).
- **Secrets stay server-side.** The API secret and access token never reach the browser.

> Status: milestone 4 of 5. Login, search, historical and live charts, watchlists, indicators,
> market depth and saved layouts work. Polish (custom timeframes, multi-chart, drawing tools)
> comes next. See [Roadmap](#roadmap).

## Requirements

- Node.js 22.12 or newer (an LTS release), and [pnpm](https://pnpm.io) 10
  (`corepack enable` installs the version pinned in `package.json`).
- For live data: a Kite Connect app on the **paid Connect plan** (₹500/month per API key).
  The free Personal plan returns no live or historical market data.
- Native build tools, only if `better-sqlite3` has no prebuilt binary for your platform
  (Python 3, `make` and a C++ compiler).

## Setup

```sh
pnpm install
cp .env.example .env    # then fill in KITE_API_KEY and KITE_API_SECRET
```

### Register the redirect URL with Kite

Zerodha sends your browser back to a fixed **redirect URL** after you log in. It must match
the server exactly:

1. Open the [Kite developer console](https://developers.kite.trade/apps) and select your app
   (or create one on the Connect plan).
2. Set **Redirect URL** to `http://127.0.0.1:8787/api/auth/callback`.
   If you change `HOST`, `PORT` or `KITE_REDIRECT_URL` in `.env`, register that URL instead.
   Use `127.0.0.1` in both places rather than mixing it with `localhost`.
3. Copy the app's **API key** and **API secret** into `.env`.

The postback URL is not used (this app does not handle orders).

## Run

```sh
pnpm start        # builds the web app and serves everything on http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787> and click **Log in with Zerodha**. After logging in on Zerodha's
page you land back in the app.

- **Search** with the box in the top bar (or press <kbd>/</kbd>): symbol or name, optionally
  `EXCHANGE:SYMBOL` (`NSE:INFY`) or extra words to narrow derivatives (`nifty fut`,
  `banknifty nov 56000 ce`). Filter chips restrict to stocks, indices, futures, options,
  commodities or currency.
- **Timeframes**: 1m, 3m, 5m, 10m, 15m, 30m, 1h and D (Kite's native intervals). The axis and
  crosshair always show IST, whatever your computer's timezone.
- **Scroll back** by dragging the chart to the right; older candles load before you reach the
  edge, until the start of the instrument's history.
- The last symbol and timeframe are restored when you reopen the app.

### Terminal

- **Watchlists** (right panel): live price, change and change % against the previous close.
  Add symbols with the box at the top, drag rows to reorder, hover a row to remove it, click to
  open its chart. Create, rename (double-click the name) and delete lists. Saved on the server.
- **Market depth** (below the watchlist) for the chart's instrument: five bid and offer levels
  with orders and quantities, total buy/sell quantity, day open/high/low/previous close,
  volume, average price and last trade; open interest for futures and options. Indices have no
  depth.
- **Indicators** (`ƒx Indicators` in the chart toolbar): SMA, EMA, Bollinger Bands and VWAP
  on the price chart; RSI, MACD and Open Interest (futures and options) in their own panes.
  They update live. Click an indicator's name in the legend to change its settings or colour;
  hover it to remove it. VWAP resets each trading day.
- **Legend** (top-left of the chart): open, high, low, close, change and volume of the candle
  under the crosshair (or the newest), and each indicator's values there.
- **Layout is restored** on reload: symbol, timeframe, indicators, panel width and which panels
  are open, saved on the server.

### Live data

While the market is open, the chart's last candle moves with every tick and new candles appear
as each period starts, on every timeframe.

- The server holds **one** connection to Kite's live feed and shares it between all browser
  tabs; your browser only talks to the local server. Chart updates are sent about 6–7 times a
  second.
- Candles start at the session open (NSE 09:15, MCX and currency 09:00). Pre-open and
  after-close ticks never create candles; the pre-open auction volume counts towards the first
  candle of the day. A candle's volume is the change in Kite's cumulative day volume.
- Live candles are approximations (Kite sends throttled snapshots, not every trade). About 10
  seconds after each candle closes, and after any reconnect, the app re-fetches the recent
  candles from Kite and replaces its own, so network drops leave no gaps or duplicates.
- The status pill in the top bar shows **Live**, **Market closed**, **Pre-open**,
  **Reconnecting** (Kite connection dropped; retries with backoff), **Offline** (lost the local
  server; reconnects by itself) or **No ticks** (in session but nothing arriving, e.g. a
  holiday — holidays aren't known to the app).
- A laptop waking from sleep reconnects and fills in what it missed. At 06:00 IST, or if Kite
  refuses the token, live data stops and the login screen appears.

To record live ticks for later replay (useful for testing on weekends), set `TICKS_RECORD=1`.
Raw frames go to `data/recordings/ticks-YYYY-MM-DD.jsonl`, which is git-ignored: never share
or commit them (Zerodha's terms forbid redistributing market data). Replay one with
`TICKS_REPLAY=data/recordings/ticks-2026-10-12.jsonl` (and optionally `REPLAY_SPEED=10`): the
server streams the recording instead of Kite's live feed and runs its clock from the recording;
history still comes from Kite, so you need to be logged in.

### Instruments and history

- The instrument list (every tradable instrument, from Kite's daily dump) is downloaded after
  login whenever the stored copy is older than the latest 08:30 IST, and again each day at
  08:30 IST while you're logged in. It's stored in `data/` keyed by `EXCHANGE:TRADINGSYMBOL`.
- Candles are cached in `data/otv.sqlite`. Past days are cached permanently; today's candles
  are refreshed (at most every 30 s) because the last one is still forming. Switching back to a
  symbol or timeframe you've already opened renders from the browser's memory immediately.
- All Kite REST calls go through one rate-limited queue (history 3/s, quotes 1/s, others
  10/s). Each history request stays within Kite's per-interval range cap (minute 60 days,
  3–10 minute 100, 15–30 minute 200, 60 minute 400, day 2000; these come from Zerodha's forum,
  not the docs, so they're configurable via `KITE_HISTORY_MAX_DAYS` and reduced automatically if
  Kite rejects a range).
- If Kite later revises past prices (a split or bonus adjustment), the app notices on the next
  refresh, drops that instrument's cached candles and reloads.
- An API key without the paid Connect plan gets a clear "no market data access" message rather
  than retries.

### The daily login

Kite access tokens expire at **06:00 IST every day** and individual users get no refresh
token, so one manual login per day is unavoidable. The app treats this as a normal state:

- The session is stored locally (in `data/`) and survives server restarts until it expires.
- At 06:00 IST, or when Kite rejects the token early (for example after logging out of Kite
  web), the app returns to the login screen with an explanation. It is one click to log in
  again.
- **Log out** in the top bar invalidates the token with Kite and clears it locally.

### Mock mode (no Zerodha account needed)

```sh
pnpm dev:mock     # or set KITE_MODE=mock in .env
```

Mock mode replaces Kite with a local fake behind the same interface. It is how the test suite
runs and how to work on the app evenings and weekends when the market is closed. It serves a
small instrument universe (NSE/BSE stocks and indices, NFO futures and options, MCX and
currency futures) with deterministic synthetic history, and behaves like Kite where it matters:
range caps, the 3/s history limit, holidays, a recently listed stock (`NEWLISTCO`) and
simulated latency (`MOCK_LATENCY_MS`, default 150 ms).

Mock mode also streams live ticks through a local server that speaks Kite's ticker protocol,
so the real connection, parser, candle builder and reconnect code all run. The ticks follow
the mock history exactly, so live candles can be checked against it. To see the market moving
on a weekend or at night:

```sh
MOCK_MARKET_OPEN=1 MOCK_SPEED=10 pnpm dev:mock         # last trading day, 11:00 IST, 10x speed
MOCK_START="2026-10-09 09:13" MOCK_SPEED=10 pnpm dev:mock  # watch the pre-open and the open
```

`curl -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:8787/api/dev/drop-ticker`
simulates a dropped Kite connection, and `/api/dev/expire-token` the 06:00 expiry (mock mode only).

## Development

```sh
pnpm dev          # server (http://127.0.0.1:8787) + Vite dev server (http://127.0.0.1:5173)
pnpm check        # lint + format check + typecheck + tests
pnpm test         # tests only (vitest); pnpm test:watch to iterate
```

During `pnpm dev`, open the Vite URL (`:5173`). Kite still redirects to the server's callback
on `:8787`, which then sends the browser back to `:5173`.

Tests run with `TZ=America/New_York` on purpose: all market-time logic must use IST explicitly
and never depend on the machine's timezone.

### Layout

```
apps/server      Fastify + SQLite (better-sqlite3): Kite session, instrument sync and search,
                 history cache, the single upstream ticker connection, live candles
  src/kite         Kite gateway (live and mock), rate limiter, REST client, market clock
  src/ticker       Ticker connection and subscriptions, tick parser, recorder/replay
  src/live         Live candle series, reconciliation, quotes, the browser WebSocket (/ws)
  src/user         Watchlists and saved preferences
  src/history      Chunked, cached history
  src/instruments  Instrument store, sync and search
  src/mock         Synthetic instruments, candles and ticks; local Kite-protocol ticker
apps/web         React + Vite UI, charts with Lightweight Charts
packages/shared  Types and pure logic shared by both: IST time, exchange sessions,
                 session-anchored bucketing, the candle builder, aggregation, indicators
```

### Data and secrets

Everything local lives in `data/` (git-ignored): the SQLite database with your session, the
instrument list, the candle cache, your watchlists and saved layout. Deleting `data/` resets
the app (watchlists and layout included); everything else is rebuilt from Kite. `.env` and recorded tick files are
git-ignored too. Do not commit any of them.

### Security notes

The server is meant for one person on one machine. Besides binding to localhost it rejects
requests whose `Host` header is not local (blocks DNS-rebinding attacks from other websites)
and requires JSON with a same-site `Origin` for state-changing requests. The access token is
stored unencrypted in `data/otv.sqlite`, which is created with owner-only permissions.

## Roadmap

1. ~~Skeleton and auth~~
2. ~~Instruments and history: daily instrument sync, search, chunked and cached history,
   candlestick chart with timeframes and scroll-back~~
3. ~~Realtime: mock tick feed, ticker manager, candle builder, live chart updates~~
4. ~~Terminal: watchlist, indicators, OHLC legend, market depth, restored layout~~
5. Polish: custom timeframes, multi-chart layout, drawing tools, keyboard search

## Licence and attribution

Charts use TradingView's open-source
[Lightweight Charts](https://github.com/tradingview/lightweight-charts) library (Apache 2.0),
with its attribution logo kept on as the licence requires; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This project is not affiliated with
TradingView or Zerodha.
