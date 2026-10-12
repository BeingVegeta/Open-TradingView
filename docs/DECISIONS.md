# Decisions and deviations from the brief

Every place where the build differs from [BRIEF.md](BRIEF.md), or fills a gap the brief left open,
with the reason. "Approved" means the user agreed to it during development; "Found" means real Kite
data or the docs contradicted the brief.

## Stack and tooling

| Decision                                                                                                                         | Brief said                             | Why                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript pinned to `~6.0`                                                                                                      | (current)                              | typescript-eslint did not support TypeScript 7 at the time. Approved.                                                                                                                                                                                                |
| Node `>=22.12`                                                                                                                   | Node current LTS                       | The development container has Node 22; Node 24 should work but is untested. Approved.                                                                                                                                                                                |
| UI is named "Open Terminal"                                                                                                      | Don't use TradingView's name in the UI | Keeps TradingView's name out of the interface; one constant in `apps/web/src/brand.ts`. Approved.                                                                                                                                                                    |
| Kite REST for history and the instrument dump uses `fetch` directly; the `kiteconnect` SDK is kept for login and logout          | Use the SDK for REST                   | The SDK formats `from`/`to` in the machine's local timezone (wrong outside India), drops HTTP status codes (429 can only be recognised by message), and drops OI values of 0. Approved for history; the instrument dump was added for the same reasons and reported. |
| Own WebSocket connection to Kite's ticker, with the SDK's `parseBinary` for packets                                              | Use the SDK's `KiteTicker`             | `KiteTicker` calls `process.exit()` after `disconnect()` and when it runs out of reconnects (every logout and 06:00 expiry), keeps global state, and does not resubscribe after reconnecting. The SDK's binary parser is still used, as the brief wanted.            |
| Login carries `redirect_params=state=<random>`; callbacks with a missing, unknown, expired (15 min) or reused state are rejected | Not in the brief                       | Requested by the user after milestone 1.                                                                                                                                                                                                                             |
| A lint rule blocks Kite order endpoints                                                                                          | "Do not call any order endpoints"      | Makes the read-only rule enforceable.                                                                                                                                                                                                                                |
| The access token is stored unencrypted in `data/otv.sqlite` (owner-only file permissions)                                        | Session persisted                      | Single user, local machine; documented in the README.                                                                                                                                                                                                                |

## Market hours and candles (found on live data)

The brief says "NSE equity trades 09:15 to 15:30 IST". Live Kite data (9 and 12 Oct 2026) and the
user's exchange and broker notices show SEBI's closing auction session (CAS):

| Instruments                              | Continuous trading, i.e. Kite's intraday candles               | Source                                                                          |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| NSE/BSE stocks with futures (F&O stocks) | 09:15–15:15, then the closing auction 15:15–15:35 (no candles) | Kite data (RELIANCE, HDFCBANK 1m candles end 15:14); auction times from notices |
| Other NSE/BSE stocks                     | 09:15–15:30                                                    | Notices; not yet seen in Kite data                                              |
| Indices                                  | 09:15–15:30                                                    | Kite data                                                                       |
| NFO/BFO futures and options              | 09:15–15:40                                                    | Kite data (futures); options assumed the same                                   |
| MCX                                      | 09:00–23:30 (23:55 in winter)                                  | Kite data                                                                       |
| Currency                                 | 09:00–17:00                                                    | Assumed                                                                         |

- Each instrument's session comes from its segment, and for cash stocks from whether the
  instrument list has futures on it. If an instrument's previous trading day ran later than that
  (up to 30 minutes), the live candle builder follows the later close. It never shortens a session,
  since an illiquid stock's last trade can be well before the close.
- The status pill follows the active chart's instrument (closing auction, F&O until 15:40, MCX in
  the evening) instead of a fixed NSE 15:30.
- **Pre-open and closing-auction volume** is not in any of Kite's intraday candles but is in the day
  candle (found on live data). The app's live candles do the same. The brief only said to "compare
  against historical data to decide what to drop".
- **Hourly candles start at 09:15 on NSE/BSE/NFO and 09:00 on MCX** (confirmed on live data, as the
  brief asked). Every 15m, 30m and 1h candle equals the aggregation of its own 1m candles.

## Reconciliation

- About 10 s after each bar closes, and after any reconnect, the recent range is re-fetched and
  replaces the live bars (live data showed Kite's history never changed after +10 s).
- Reconciliation is authoritative for the range it fetched: a live bar Kite doesn't have is removed
  (for example bars built from ticks after a stock's 15:15 close), but only once it closed more than
  a minute ago, so a lagging history response can't delete a real bar.
- The day's last bar is replaced by Kite's version once its period ends.

## Timeframes and history

- **2h and 4h** are aggregated on the server from 60-minute candles, anchored to the session open
  (NSE 09:15, 11:15, 13:15, 15:15; the last bar of a day is short). **Weeks** start on Monday and
  **months** on the 1st, both stamped 00:00 IST like Kite's daily candles, aggregated from daily
  candles. A history page drops its oldest aggregated bar while more history exists, so scrolling
  back never shows a partial bar.
- **Initial load sizes**: 1,000 bars, except 400 weeks and 240 months (one Kite request of daily
  candles instead of up to a dozen). Scroll-back starts fetching when two screens of older bars
  remain.
- **Range caps** are the forum figures from the brief, configurable with `KITE_HISTORY_MAX_DAYS`, and
  halved automatically if Kite rejects a range.
- Settled days are cached permanently; today's candles are refreshed at most every 30 s. A change of
  more than 1% in the newest settled close (a split or bonus) drops the instrument's cache.
- `PermissionException` is not in Kite's documented exception list, so "no market data" is also
  recognised from the message ("Insufficient permission").

## Live data

- Chart updates are coalesced to about 6–7 per second per chart (150 ms), watchlist quotes to 4 per
  second (250 ms): within the brief's 4–10.
- Instruments on an open chart and the depth panel use `full` mode; watchlist rows use `quote`
  (the brief allowed `ltp` or `quote`; `quote` carries the day OHLC needed for change %).
- Prices use the SDK's divisors. The SDK divides BSE currency (BCD) prices by 10,000 where the docs
  say currencies use 10,000,000; unverified, matters only for BCD.
- Exchange holidays aren't known to the app: on a holiday the pill shows "No ticks".

## Mock mode and data

- A Live/Mock switch in the UI restarts the server in the other mode (requested by the user).
  `pnpm start` always starts in the mode set in `.env`. Mock mode keeps its data in `data/mock/`,
  separate from real data in `data/`.
- The mock follows the real session rules above, including pre-open and closing-auction volume that
  appears only in the day total.
- `/api/dev/anchoring`, `/api/dev/diagnostics` and `/api/dev/aggregation` were added to verify
  candle times and live-vs-Kite candles against real data without sharing price history.

## Terminal features

- Layout, timeframe and indicators are saved on the server (and cached in `localStorage` for a fast
  first paint), so they survive a cleared browser.
- Indicators belong to a chart, not to a symbol.
- Up to four charts (grids of 1, 2, 3 or 4); the toolbar, search, watchlist clicks and depth panel
  act on the active chart.
- Drawings (horizontal line, trend line) belong to an instrument and show on every timeframe and
  every chart of it. Each endpoint is placed on the bar that contains it on the current timeframe;
  beyond the loaded bars, positions are extrapolated over trading sessions (weekdays, session hours;
  holidays aren't known).
- Search ranking ties are broken with a hand-kept list of about 70 liquid NSE names, since the
  instrument dump has no popularity data.
- Keyboard symbol search: typing a letter anywhere outside a text field starts a search for the
  active chart (and <kbd>/</kbd> focuses the box). Drawing tools use <kbd>Alt</kbd>+<kbd>H</kbd> and
  <kbd>Alt</kbd>+<kbd>T</kbd>, so plain letters stay free for search.
- Failed saves and loads (drawings, layout, watchlists, search) show a short notice rather than
  failing silently; the server-unreachable and logged-out states have their own screens.
