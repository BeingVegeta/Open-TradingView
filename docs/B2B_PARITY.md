# N-B2B parity: does the port reproduce TradingView?

The app runs a TypeScript port of Varun's "NIFTY 2-Lot Block-to-Block v1.8" Pine script
(`packages/shared/src/b2b/engine.ts`). On 16-Oct-2026 its call log differed from TradingView's.
This page records what is known, the tools that settle the rest, and how to read their output.

**Status (21-Oct-2026): one translation bug found and fixed; the full check is pending.** The
Pine tie test showed the port picked the wrong bar when two swing highs or lows tie (below). The
engine now follows Pine. Whether everything else matches bar by bar still needs a TradingView
export and an app export (steps 2–3 below).

## What is established

### 16-Oct: the two call logs, row by row

From screenshots of both CALL LOG tables (TradingView: 18 trades, +98.72 pts; app: 20 trades,
+33.02 pts):

- All 18 TradingView calls appear in the app's log.
- 14 match in time, option and result. Their entries and points differ by a few tenths.
- 12:37 and 13:45 appear in the app at 12:38 and 13:49, with the same results.
- 14:16 is the same call with a different strike: TradingView's entry 23099.95 gives the 23100 PE,
  the app's 23100.1 gives the 23200 PE. Both hit the stop.
- **12:03 PE ends differently.** TradingView's best move was +10.1, which moved the stops; the app's
  was +9.75, so both lots were stopped out (+4.5 against −20: −24.5 pts).
- **13:34 CE and 13:57 CE are only in the app.** Both were stopped out (−40 pts).

Those three rows account for −64.5 of the −65.7-point gap. The other −1.2 is small price
differences spread over the matching trades.

### Kite's and TradingView's NIFTY 1-minute candles differ

The same minute's close differs by about 0.05–0.5 points. Three examples from 16-Oct:

| Minute | TradingView | Kite     |
| ------ | ----------- | -------- |
| 14:45  | 23096.9     | 23096.8  |
| 14:16  | 23099.95    | 23100.1  |
| 14:02  | 23112.9     | 23112.75 |

The script's rules have exact edges: a close beyond a zone, a 10-point stop, the +10 trigger. A
difference this small can move a call by a minute, flip a strike, add or remove a call, or change
a trade's outcome (12:03 above). **No change to the engine can remove this.** Expect the two logs
to be close, not identical, whenever they run on different data.

### Kite ends each day's index candles on the official close

On 16-Oct, Kite's 15:28 candle jumps from about 23,119 to NIFTY's official close of 23,146.15
(from the closing auction), and 15:29 stays there. On 15-Oct the jump came at about 15:26.
TradingView's candles don't have it.

The app now drops these trailing candles from a finished day before running the script
(`dropClosingPrints`; see DECISIONS.md). One known side effect: on a day with the jump, a swing
point at 15:23–15:24 can't be confirmed, because the five bars after it are cut.

**Open question:** on 15-Oct, Kite's NIFTY is flat from about 15:14 to 15:25. TradingView's 15-Oct
chart hasn't been checked for the same stretch.

### Swing-point ties: the port had it backwards (fixed 21-Oct)

The script finds swings with `ta.pivothigh(high, 5, 5)` and `ta.pivotlow(low, 5, 5)`. TradingView's
reference doesn't say what happens when the candidate bar ties with another bar in its window.

- **The port until 21-Oct (`pivotTie: 'older'`):** the left side had to be strictly lower and the
  right side could tie, so of two equal highs the **older** one was the pivot.
- **[PyneCore](https://github.com/PyneSys/pynecore)**, a Python reimplementation of Pine:
  `pivothigh` calls `highest(…, _check_eq=True)`, documented as "Keep the NEWEST of equal extremes
  (pivot detection)". The left side may tie and the right side must be strictly lower, so of two
  equal highs the **newer** one is the pivot.
- **TradingView itself** ([the tie test](pine/pivot_tie_test.pine), run 21-Oct): `pivothigh`
  reported the newer bar 480 times and the older bar 0 times; `pivotlow` 479 and 0. **Pine keeps
  the newer of equal extremes.**

The engine's default is now `'newer'`, in the dashboard and the paper trader alike. Ties are common
on NIFTY 1m (0.05 steps, flat stretches), so the old rule moved swing points, and with them zones
and calls. `pivotTie: 'older'` and `pnpm b2b:compare --pivot-tie older` still run the old rule, to
see what it changed.

Paper trades record a fingerprint of the settings and the engine version (`B2B_ENGINE_REV`, now 2),
so the Paper tab's breakdown by settings version separates trades made before the fix (19–21 Oct)
from those after.

## How to settle it

### 1. The Pine tie test (2 minutes, no export needed)

Add [`docs/pine/pivot_tie_test.pine`](pine/pivot_tie_test.pine) to any TradingView chart (Pine
Editor → paste → Add to chart). Its series is synthetic, so the symbol and timeframe don't matter.
It feeds a repeating pattern with one pair of equal highs and one pair of equal lows into
`ta.pivothigh(src, 5, 5)` and `ta.pivotlow(src, 5, 5)`, and its table counts which bar of each pair
was reported:

| Table shows              | Meaning                                   |
| ------------------------ | ----------------------------------------- |
| counts under "older bar" | the port's original rule ('older')        |
| counts under "newer bar" | PyneCore's rule ('newer'): the result     |
| counts under both        | ties never block a pivot (a third rule)   |
| zeros in both            | ties always block a pivot (a fourth rule) |

Result on 21-Oct: newer bar 480 / 479, older bar 0 / 0, other 0 / 0.

### 2. TradingView export

On TradingView, open NIFTY 50 at 1 minute with the N-B2B indicator on the chart, set to the same
inputs as the app's dashboard. Then use chart menu → **Export chart data…**. This may need a paid
TradingView plan.

- The export holds each bar's prices and every plot of every indicator on the chart. The script's
  five plots ("Entry", "SL lot 1", "SL lot 2", "Lot 1 booking level (+15)", "Protection trigger
  (+10)") are its trade state on every bar. This lets the tool check the engine bar by bar,
  without typing in a call log. If another indicator also plots something called "Entry", hide
  or remove it before exporting.
- Export right after the session you want to check. The script ran on exactly the bars loaded
  on the chart, and the export contains those bars.
- In the export dialog choose **UNIX timestamp** for the time format, so the time zone can't
  be misread.
- Save it under `data/` (git-ignored), e.g. `data/tv-2026-10-19.csv`. It is market data: never
  commit or share it.
- If the tool says it found no script plot columns, send the CSV's first line (the column names
  only, no prices) so the parser can be adjusted to TradingView's naming.

### 3. App export

The endpoint came with the update that added this page. Pull and restart only after the close:
a restart during market hours makes the paper trader miss calls. After 15:30 IST, with the app
running, open
`http://127.0.0.1:8787/api/paper/export?day=2026-10-19` and save it as
`data/paper-2026-10-19.json`.

It holds the day's paper trades and events, the dashboard settings, and the 1-minute candles the
trader holds at export time. Bars it has reconciled with Kite are Kite's final versions; after a
restart, it holds Kite's history only. The comparison in section 5 below is therefore "the live
decisions against a replay on the final candles", which is what catches calls Kite's later
corrections took away.

### 4. Run

```powershell
pnpm b2b:compare --tv data\tv-2026-10-19.csv --app-log data\paper-2026-10-19.json --day 2026-10-19
```

Other forms: `--tv` alone; `--kite FILE` (a Kite CSV, Kite's JSON or an app export) instead of the
export's candles; `--settings app` to use the dashboard's settings from the export;
`--pivot-tie newer`; `--warmup N|all`; `--tol 0.05`; `--bars`. `pnpm b2b:compare --help` lists
them all.

The output has these sections:

1. **Engine on TradingView candles.** Runs the engine on TradingView's own bars, all of them,
   with no closing-print trimming, under both tie rules. It compares the engine's plots with the
   script's plots on every bar, prints the first diverging bar and the engine's state there
   (position, zones, recent swing points, the last three bars), the swing points the two rules
   disagree on, and the day's call log and alerts.
2. **Engine on Kite candles.** Runs the engine as the app does, and lists the closing-print bars
   it dropped.
3. **Candles: Kite − TradingView.** The first bar that differs by more than the tolerance (and the
   first among the bars the app uses), the day's largest high, low and close differences, and
   every differing bar.
4. **Call logs side by side.** Both runs start on the same first bar. `!` marks a different
   decision, `~` the same trade at different prices, `>> FIRST` the first decision that differs,
   with each side's engine state on the bar before it.
5. **Offline run vs the live paper trader.** Flags calls taken live but missing from the final
   candles (Kite corrected a candle after the call), and calls the live trader didn't take.

### Reading the verdict

The verdict comes from the "Bar-by-bar check" line of section 1:

- **`pivot tie newer: … 0 differ`:** the port reproduces TradingView exactly on TradingView's
  candles. Every remaining difference comes from the data (sections 3 and 4). The `older` line
  shows how many bars the old tie rule got wrong.
- **`newer` isn't 0:** another translation bug. The tool prints `FIRST DIVERGING BAR` and the engine's
  state on that bar. That bar and state are what's needed to find the bug. Don't adjust anything
  else until it's understood.

### 19-Oct: the live paper trader against a replay (second machine)

Exported from a second machine running the app at `dd1c194`; 20-Oct was a market holiday. The
replay of Kite's final candles made 17 calls (+146.08 pts); the live trader made 6 trades
(+104.8 script pts, ₹4,601 net after costs). The event timeline shows why:

- The live trader was **frozen** from about 10:12 to 10:16:46, 10:42 to 11:49 and 12:56 to 14:50
  (events for a candle are recorded only when the trader wakes, minutes or hours after it
  closed). This is the machine sleeping, not the app being closed: a restart reloads full history
  and notes "closed while the app was off", and none of that happened.
- On waking, the live feed resends only its last five bars, so the trader ran the script on candles
  with a hole. Calls at 10:12, 10:13 and 10:17 came from that holed series (the replay doesn't have
  them); the first two were entered about three minutes late. The 10:33 trade was held through the
  10:42–11:44 hole and exited at 11:47 (+80.35 instead of +55.37), the 12:54 one through
  12:56–14:45 (+64.94 instead of +6.75). Every call the replay makes while the machine slept was
  missed.
- The options traded expired the same day: the weekly expiry moved to Monday because Tuesday was a
  holiday. Expiry-day premiums move sharply, which shows in the fills.

Fixed since (see DECISIONS.md): the trader refetches missing minutes and records late calls as
`MISSED`. The engine itself reproduced its own live decisions wherever the live run had the
same candles (10:30, 10:33 entry). The swing-point tie rule changes nothing on Kite's 19-Oct or
21-Oct candles.

### 16-Oct again: the current engine on Kite's candles vs TradingView's log

Run on 21-Oct with the current engine (Pine's tie rule, closing prints dropped) on Kite's
candles from the second machine's export, against TradingView's 18-row CALL LOG:

- 14 of TradingView's 18 calls match in time, option and result (6 exactly; 8 with entries
  0.05–0.85 apart and points a few tenths apart).
- **12:03:** Kite's best move was +9.75, TradingView's +10.1, so only TradingView moved the stops.
  **14:16:** entry 23100.1 vs 23099.95 gives a different strike. **12:37** is 12:38 on Kite.
  All three are price differences.
- **09:31 (extra, ours):** on 15-Oct Kite's NIFTY is frozen at 22939.95 from 15:15 to 15:27
  (open = high = low = close for 13 bars). Pine's tie rule makes the newest of those equal lows,
  15:27, a swing low, and the 16-Oct 09:31 close breaks it. TradingView made no 09:31 call, so its
  15-Oct candles are probably not frozen. The old tie rule ignored the flat run, which is why it
  happened to match here.
- **13:34 and 13:57 (extra, ours) and 13:45 vs 13:49:** not tie-related; both rules agree. 13:34
  is a breaker: the 12:52 bear block (23124.65–23132.6) is broken by the 13:33 and 13:34 closes,
  which clear its top plus the ATR buffer by 1.06 and 2.83 points. Whether TradingView's 12:52
  candle and 13:33–13:34 closes do the same decides it.

No rule difference other than the tie rule has been found. To settle the last two items without a
paid export, read these NIFTY 50 1-minute candles off TradingView: 15-Oct 15:10–15:29, and 16-Oct
12:52 and 13:32–13:34.

## Results

_Not yet run._ Fill in from the tool's output:

| Day | Bars | Pivot tie | Bars differing (older / newer) | First diverging bar | Engine on TV candles = TV log? |
| --- | ---- | --------- | ------------------------------ | ------------------- | ------------------------------ |
|     |      |           |                                |                     |                                |

Pine tie test (21-Oct-2026): `pivothigh` newer bar 480, older bar 0; `pivotlow` newer bar 479,
older bar 0. Pine keeps the newer of equal extremes; the engine's default was switched to match.

## What the two "Net" figures mean

They measure different things. Even on a day when both logs match perfectly, the app's figure
will read lower.

- **Pine's "Net Rs"** (the CALL LOG header, and the dashboard's Signals tab, which copies it) is
  the script's arithmetic: the sum of both lots' index points × the script's lot-size input (65).
  It assumes the option moves one-for-one with NIFTY (delta 1), fills at exactly the stop or
  target level, and has no spread and no charges. With `measure = premium`, the points are first
  scaled by the delta input (0.65).
- **The Paper trading tab's "Net (after costs)"** is what an account would have seen: for each lot,
  (option exit fill − option entry fill) × the contract's lot size from Kite × lots, minus
  estimated charges. Three things make it lower:
  1. **Delta below 1.** The in-the-money option moves about 0.6–0.7 points per NIFTY point, so a
     +10 index move is worth about +6.5 option points.
  2. **Spread and slippage.** Entries fill at the best offer and exits at the best bid. Exits
     happen at the market a second or two after the candle closes, not at the stop level.
  3. **Charges.** About ₹80–100 per two-lot round trip (brokerage, STT, exchange fees, GST,
     stamp duty).

  Its trades table has a "Script pts" column beside "Net ₹", so the two can be compared trade by
  trade.
