# Live checks

Everything in v1 that has only been verified against the mock feed, as a checklist for a trading
day. Times are given in Singapore time (SGT) with IST in brackets (IST = SGT − 2:30).

Do the sections in this order. Each step says what to look for and what to send. Send JSON from
the `/api/dev/…` pages as it is: it contains times, volumes and yes/no answers, not price series.
Never send the tick recording itself (Zerodha's terms forbid redistributing market data).

## Before you start (once)

1. Update and install, in PowerShell in the project folder:

   ```powershell
   git pull
   pnpm install
   ```

2. Turn the tick recorder on: open `.env` (`notepad .env`) and add the line

   ```
   TICKS_RECORD=1
   ```

   Then start the app with `pnpm start`. Every tick Kite sends is appended to
   `data\recordings\ticks-YYYY-MM-DD.jsonl` (one file per IST day; a full day of four charts
   and a watchlist can reach tens of MB). The folder is git-ignored. Keep the files on your
   machine: if something needs debugging, you can replay the day locally with `TICKS_REPLAY`
   (see the README) while I tell you what to look at. To turn it off, delete the line (or set
   `TICKS_RECORD=0`) and restart.

3. Keep the PowerShell window with the server log open; some steps ask for log lines.

Instrument keys in the URLs below must be URL-encoded: a space is `%20` and `&` is `%26`
(`NSE:NIFTY%2050`, `NSE:M%26M`). The examples use `NSE:RELIANCE`; replace the placeholders with
your picks.

## 1. One closing session: 17:30 to 18:15 SGT (15:00–15:45 IST)

Most of the unverified behaviour happens in these 45 minutes.

### Set up (by 17:30 SGT)

1. Log in, open the **four-chart layout** (rightmost layout button) and set every chart to **1m**:
   - chart 1: an **F&O stock**, e.g. `NSE:RELIANCE` (it has futures);
   - chart 2: a **stock that is not in F&O** (any NSE stock you know has no futures);
   - chart 3: a **NIFTY option** of the nearest expiry, near the money (search e.g. `nifty 25000 ce`);
   - chart 4: the **index** `NSE:NIFTY 50`.
2. Check the app classified the two stocks the way you expect. Open
   `http://127.0.0.1:8787/api/dev/aggregation?keys=NSE:RELIANCE,NSE:<YOUR_NON_FNO_STOCK>` and look
   at `appClosingAuction` (true for the F&O stock, false for the other) and `appSessionEnd`
   (15:15 and 15:30). **Send** it if either is wrong.
3. **Switch timings** (any time in this window, takes 2 minutes): open
   `http://127.0.0.1:8787/?perf=1`, add five indicators to chart 1 (SMA, EMA, Bollinger, RSI,
   MACD), then click between 1m, 5m, 15m, 1h and D about 20 times. The panel at the bottom right
   lists each switch. Click **Copy** and **send** the result. (`?perf=0` turns the panel off.)

### At the close

Poll the tick snapshot page at the times below. Each request reports what changed since the
previous one, so keep the same tab and use the same URL every time:

`http://127.0.0.1:8787/api/dev/ticks?keys=NSE:RELIANCE,NSE:<NON_FNO>,NFO:<OPTION>,NSE:NIFTY%2050`

Copy each response into a text file with the time you took it, and **send** the file at the end.

| SGT (IST)                                 | Do                                               | What to look for                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17:40 (15:10)                             | Tick snapshot                                    | Baseline.                                                                                                                                                                                 |
| 17:46 (15:16)                             | Tick snapshot; click chart 1                     | Chart 1's legend shows **CLOSING AUCTION**, its last candle is **15:14** and no new one appears. The top pill says **Closing auction** while chart 1 is active. Charts 2–4 keep updating. |
| 17:50, 17:55, 18:00 (15:20, 15:25, 15:30) | Tick snapshot each time                          | For the F&O stock: does `dayVolume` grow during the auction, and does `priceMovedSincePreviousRequest` say the price moves? (The app assumes the auction's volume arrives at the end.)    |
| 18:01 (15:31)                             | Look                                             | Charts 2 and 4: last candle **15:29**, legend says **MARKET CLOSED**. The option keeps updating.                                                                                          |
| 18:04 and 18:07 (15:34, 15:37)            | Tick snapshot each time                          | Around 15:35 the F&O stock's auction ends: expect a jump in `dayVolume` and a final price move.                                                                                           |
| 18:11 (15:41)                             | Look; click chart 3                              | The option's last candle is **15:39**; with chart 3 active the pill says **Market closed**.                                                                                               |
| 18:15 (15:45)                             | Open `http://127.0.0.1:8787/api/dev/diagnostics` | **Send** it. It compares the app's live candles with Kite's for every chart, through the close.                                                                                           |

Also at 18:15 SGT, switch chart 1 to **D**: the newest daily candle's close and volume should
match Kite's own chart (the close is the auction price, the volume includes the pre-open and the
auction). **Send** both numbers from each side only if they differ.

**Screenshots to send:** the whole window at 17:46 (auction) and at 18:11 (everything closed).

## 2. Overnight run through the 06:00 IST expiry (08:30 SGT next morning)

1. In the evening, leave `pnpm start` running and the browser tab open. Change chart 2 to an
   **MCX crude oil future** on 1m (search `crudeoil fut`, nearest expiry) to check the evening
   session too. Don't let the laptop sleep tonight (that's section 3).
2. Before going to bed, glance at the pill with the crude chart active: it should say **Live**
   until MCX closes (23:30 IST, 02:00 SGT, while US daylight saving lasts; 23:55 IST after it
   ends).
3. **At 08:30 SGT (06:00 IST)** the app should switch to the login screen by itself, saying the
   daily session ended. In the server log, look for `Kite session ended` with `reason: "expired"`
   and the ticker stopping (no `Kite ticker reconnect scheduled` loop afterwards).
   **Send:** a screenshot of the login screen and the log lines from 05:59 to 06:02 IST
   (08:29–08:32 SGT).
4. Log in again. The charts, layout and drawings should come back as they were.
5. Now that yesterday is a complete day, open
   `http://127.0.0.1:8787/api/dev/aggregation?keys=NSE:RELIANCE,NSE:<NON_FNO>,NFO:<OPTION>,MCX:<CRUDE_FUTURE>`
   and **send** it. Expected `last1m`: 15:14 (F&O stock), 15:29 (other stock), 15:39 (option),
   23:29 (crude, while US daylight saving lasts). Also check the server log from the previous
   day for any `Session close differs from the default` line, and **send** it if there is one.
6. **Aggregated timeframes:** compare a few recent candles of RELIANCE on **4h** and **W** with
   Kite's own chart. 4h candles start 09:15 and 13:15 (the second ends at 15:15 for F&O stocks).
   Weeks start on Monday. **Send** any candle whose open, high, low or close differs.

## 3. Wi-Fi off/on and laptop sleep (market hours, about 15 minutes)

Use the four-chart layout on 1m. Before each test, note the time.

1. **Wi-Fi off for 30 seconds**, then on. Within about 7 seconds of going off, the pill should
   say **Reconnecting in …s** (the connection to your local server stays up; only Kite's drops).
   After Wi-Fi returns it should say **Live** within about 40 seconds (retries back off to 30 s,
   ±25%), and the 1m charts should have no gap or doubled candle around the outage (the missed
   minutes are filled from Kite's history).
2. **Wi-Fi off for 3 minutes**, then on. Same checks.
3. **Laptop sleep for 5 minutes** (close the lid), then wake it. The pill may briefly say
   **Offline** or **Reconnecting**, then **Live**; the charts fill in the minutes you missed.
4. **Send:** `http://127.0.0.1:8787/api/dev/diagnostics`, the server log lines around each
   outage (lines containing `ticker`), and a screenshot of any chart that shows a gap or a
   doubled candle.

## 4. Low priority (only if convenient)

- **Currency (CDS) session.** Open a **monthly** USDINR future on 1h. The first candle should
  start at 09:00 and the last 1m candle should be 16:59. Check it the next day with
  `/api/dev/aggregation?keys=CDS:<USDINR_FUTURE>`.
- **BSE currency (BCD) prices**, only if you trade BCD: compare a price in the app with Kite's.
  The SDK divides BCD prices by 10,000 while the docs say currencies use 10,000,000, so a
  mismatch would be a factor of 1,000.
- **"No market data" message**, only if you have a second API key on the free Personal plan: log
  in with it and open a chart. Expect the "No market data access" card, not retries.
- **Kite's rate-limit (429) and range-cap texts.** If the server log ever shows `Too many requests`
  or `Kite rejected the history range`, **send** that line. You don't need to provoke them.

## What to send, in one place

From section 1: the aggregation check if wrong, the Copy output of the switch timings, the
tick-snapshot file, `/api/dev/diagnostics`, the two screenshots, and daily-candle numbers only if
they differ. From section 2: the login-screen screenshot and log lines, the next-day aggregation,
any `Session close differs` line, and 4h/W mismatches. From section 3: diagnostics, log lines and
screenshots of any gap. From section 4: whatever you checked.
