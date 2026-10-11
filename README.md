# Open-TradingView

A self-hosted, realtime charting terminal for Indian markets, running on your own machine
against your own [Zerodha Kite Connect](https://kite.trade/docs/connect/v3/) API key.

- **Single user, localhost only.** One backend process holds your Kite session; your browser
  talks only to it. Zerodha's terms forbid redistributing API market data, so the server binds
  to `127.0.0.1` and has no multi-user features.
- **Read-only.** The app never calls Kite's order endpoints (enforced by a lint rule).
- **Secrets stay server-side.** The API secret and access token never reach the browser.

> Status: milestone 1 of 5 (skeleton and login). Charts, live data and the terminal features
> are being built next; see [Roadmap](#roadmap).

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
runs and how to work on the app evenings and weekends when the market is closed.

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
apps/server      Fastify + SQLite (better-sqlite3); owns the Kite session and, later, the
                 single upstream ticker connection
apps/web         React + Vite UI
packages/shared  Types and pure logic shared by both (IST time helpers, later candle
                 aggregation and indicators)
```

### Data and secrets

Everything local lives in `data/` (git-ignored): the SQLite database with your session and,
later, the instrument list, candle cache and watchlists. `.env` and recorded tick files are
git-ignored too. Do not commit any of them.

### Security notes

The server is meant for one person on one machine. Besides binding to localhost it rejects
requests whose `Host` header is not local (blocks DNS-rebinding attacks from other websites)
and requires JSON with a same-site `Origin` for state-changing requests. The access token is
stored unencrypted in `data/otv.sqlite`, which is created with owner-only permissions.

## Roadmap

1. ~~Skeleton and auth~~
2. Instruments and history: daily instrument sync, search, chunked and cached history,
   candlestick chart with timeframes and scroll-back
3. Realtime: mock tick feed, ticker manager, candle builder, live chart updates
4. Terminal: watchlist, indicators, OHLC legend, market depth, restored layout
5. Polish: custom timeframes, multi-chart layout, drawing tools, keyboard search

## Licence and attribution

Charts will use TradingView's open-source
[Lightweight Charts](https://github.com/tradingview/lightweight-charts) library (Apache 2.0),
with its attribution kept on as the licence requires. This project is not affiliated with
TradingView or Zerodha.
