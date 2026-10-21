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

## Varun's dashboard (N-B2B v1.8 port)

- The script is ported to TypeScript in `packages/shared/src/b2b/` and runs in the browser for the
  dashboard and on the server for paper trading, so both see the same calls. Each closed bar is
  processed in the script's order: new-day resets, pivots, new blocks, survival and breakers,
  trimming, trade management, entries. Trades and zones change only on closed candles
  (`barstate.isconfirmed`); live P&L comes from the forming candle, as the script's tables do.
- It always runs on the instrument's 1m candles, whatever the chart's timeframe; the drawings show
  only on a 1m chart. It starts from about 5,000 bars of history, while TradingView may start
  further back, so zones carried over from older history can differ near the start of the data.
  Calls on the current day should not depend on it.
- Pivot ties: Pine's reference doesn't say which of two equal highs (lows) `ta.pivothigh`
  (`pivotlow`) reports. The port first took the older one; a test on TradingView
  (`docs/pine/pivot_tie_test.pine`, 21-Oct-2026) showed Pine takes the newer one, as PyneCore's
  implementation does, and the engine now matches. `pivotTie: 'older'` keeps the old rule for
  comparisons. See [B2B_PARITY.md](B2B_PARITY.md).
- `ta.atr` is an RMA of the true range seeded with a simple average, as in Pine. Labels are capped
  at 300, like the script's `max_labels_count`.
- The script's settings are saved with the layout on the server. The paper trader reads the same
  settings, so changing them on the dashboard changes what is paper-traded from the next candle.
  A mid-day change re-runs the whole day with the new settings; an open trade the new settings
  don't have is closed with the note "call withdrawn".

- **TradingView's NIFTY day ends at 15:14; Kite's runs to 15:29** (found by reading TradingView's
  candles with a Pine table, 13, 15 and 16 Oct 2026). Kite's 15:15–15:29 bars are frozen prices
  (15-Oct: 22939.95 for 13 bars) or end on the official closing value from the closing auction
  (16-Oct: a jump to 23,146.15). They created swing points and broke zones the script on
  TradingView never sees. For indices the script (dashboard and paper trading) now runs on bars up
  to 15:14 only (`tradingViewIndexSession`, replacing the earlier closing-print rule); the chart
  still shows Kite's candles as they are. Nothing trades after the 15:15 square-off.
- Even so, Kite's and TradingView's NIFTY 1-minute closes differ by about 0.05–0.5 points, so the
  two call logs can differ by a minute, a strike or an extra call where a close is right at a
  zone edge or a stop. On 16-Oct, 9 of the 11 calls compared matched in time and result.

## Paper trading

- Runs on the server, on `NSE:NIFTY 50` 1m, independently of which chart the dashboard is attached
  to or whether a browser is open. Only calls made on candles that closed while it was running are
  traded; calls missed while the app was off stay missed.
- **On by default**, as asked ("from Monday"). The switch is in the Paper trading tab.
- **Contract**: the strike the script names (in the money: the round figure below spot for calls,
  above for puts) on the nearest NIFTY expiry that hasn't passed. "Next one on expiry day" in the
  tab moves to the next expiry on expiry days. The lot size comes from Kite's instrument list (the
  script's own lot-size input is used only for its ₹ figures, which are stored separately).
- **Fills**: entry at the best offer, exits at the best bid, at the moment the trader sees the
  closed candle (a second or two after the minute). If the option has no depth the last price is
  used, with a note on the trade. A stop is therefore filled at the market after the candle closes,
  not at the stop level; the script's own points are stored alongside so the slippage between the
  two is visible. To have prices ready, it keeps the NIFTY options within four strikes of spot (CE
  and PE, nearest expiry) subscribed in full mode.
- **Costs** are estimates of Zerodha's charges for index options (₹20 an order, STT 0.1% on sells,
  NSE transaction 0.03503%, SEBI fees, stamp 0.003% on buys, 18% GST). Each lot's exit counts as
  its own order. They aren't editable in the UI yet; check them against a contract note.
- After a restart, an open trade is carried on if the script still has it open; otherwise it is
  closed at the current price with a note. A call that disappears after Kite's corrected candle
  replaces the live one is closed the same way ("call withdrawn"). Trades never carry over to the
  next day.
- **A sleeping machine** (found on 19-Oct-2026, on a second machine) freezes the trader, and on
  waking the live feed resends only its last five bars. The trader then ran the script on candles
  with a 1–2 hour hole, held a trade through it, and entered calls minutes late at the prices of
  the moment. Now it refetches today's missing minutes from Kite before each run (at most once a
  minute), and a call whose candle closed more than 90 s earlier is recorded as `MISSED` instead
  of entered. An exit found late is still filled, at the current price, with a note. A machine
  that sleeps through a session still misses everything while asleep: keep it awake.
- Metrics count closed trades only. A trade without an option price counts with the script's ₹.
