import {
  formatIstDateTime,
  type PaperConfig,
  type PaperMetrics,
  type PaperStatus,
  type PaperTrade,
} from '@otv/shared';
import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { failure, notify } from '../components/Toasts';
import { useMarketNow } from '../live/useMarketNow';

type Range = 'today' | '7d' | '30d' | 'all';
const RANGES: { id: Range; label: string; days: number | null }[] = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'all', label: 'All', days: null },
];

const ymd = (ms: number) => formatIstDateTime(ms).slice(0, 10);
const hm = (ms: number | undefined) => (ms ? formatIstDateTime(ms).slice(11, 16) : '');
const rs = (v: number | null | undefined) =>
  v === null || v === undefined
    ? '–'
    : `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const num = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '–' : Number(v.toFixed(d)).toString();
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined || v === 0 ? '' : v > 0 ? 'up' : 'down';

const STATE_TEXT: Record<PaperStatus['state'], string> = {
  off: 'Off',
  'waiting-login': 'Waiting for login',
  'waiting-instruments': 'Waiting for the instrument list',
  loading: 'Starting…',
  running: 'Running',
  error: 'Error',
};

/** A small equity curve: cumulative net ₹ after each closed trade. */
function Equity({ points }: { points: PaperMetrics['equity'] }) {
  if (points.length < 2)
    return <p className="muted paper-note">The equity curve appears after two closed trades.</p>;
  const w = 320;
  const h = 70;
  const ys = [0, ...points.map((p) => p.cumRs)];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const y = (v: number) => (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h);
  const x = (i: number) => (i / points.length) * w;
  const path = [`M0,${y(0)}`, ...points.map((p, i) => `L${x(i + 1)},${y(p.cumRs)}`)].join(' ');
  const last = points.at(-1)!.cumRs;
  return (
    <svg
      className="paper-equity"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Equity curve"
    >
      <line x1="0" x2={w} y1={y(0)} y2={y(0)} className="paper-zero" />
      <path d={path} className={last >= 0 ? 'paper-line-up' : 'paper-line-down'} />
    </svg>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; trades: number; winRate: number | null; netRs: number }[];
}) {
  if (!rows.length) return null;
  return (
    <table className="paper-mini">
      <thead>
        <tr>
          <th>{title}</th>
          <th>Trades</th>
          <th>Win</th>
          <th>Net</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td>{r.trades}</td>
            <td>{pct(r.winRate)}</td>
            <td className={tone(r.netRs)}>{rs(r.netRs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Counts({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const total = entries.reduce((a, [, n]) => a + n, 0);
  return (
    <table className="paper-mini">
      <thead>
        <tr>
          <th>{title}</th>
          <th>Count</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([k, n]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{n}</td>
            <td>{pct(n / total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Auto paper trading of Varun's script: switch, status, efficacy metrics and every trade. */
export function PaperPanel() {
  const { marketNow } = useMarketNow();
  const today = ymd(marketNow);
  const [range, setRange] = useState<Range>('today');
  const [status, setStatus] = useState<(PaperStatus & { config: PaperConfig }) | null>(null);
  const [metrics, setMetrics] = useState<PaperMetrics | null>(null);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [tick, setTick] = useState(0);

  const days = RANGES.find((r) => r.id === range)!.days;
  const from = days === null ? undefined : ymd(marketNow - (days - 1) * 86_400_000);
  const q = qs({ from, to: days === null ? undefined : today });

  useEffect(() => {
    let stop = false;
    const load = () =>
      Promise.all([
        api.get<PaperStatus & { config: PaperConfig }>('/api/paper/status'),
        api.get<PaperMetrics>(`/api/paper/metrics?${q}`),
        api.get<PaperTrade[]>(`/api/paper/trades?${q}`),
      ])
        .then(([s, m, t]) => {
          if (stop) return;
          setStatus(s);
          setMetrics(m);
          setTrades(t);
        })
        .catch(() => {});
    void load();
    const id = window.setInterval(load, 5000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [q, tick]);

  const toggle = () =>
    api
      .put<PaperStatus & { config: PaperConfig }>('/api/paper/config', {
        enabled: !status?.config.enabled,
      })
      .then((s) => {
        setStatus(s);
        setTick((n) => n + 1);
      })
      .catch((e: unknown) => notify(failure("Couldn't change paper trading", e)));
  const setExpiry = (expiry: PaperConfig['expiry']) =>
    api
      .put('/api/paper/config', { expiry })
      .then(() => setTick((n) => n + 1))
      .catch((e: unknown) => notify(failure("Couldn't change the expiry rule", e)));

  const m = metrics;
  const open = status?.openTrade ?? null;
  return (
    <div className="paper">
      <div className="paper-bar">
        <button
          className={`btn btn-sm ${status?.config.enabled ? 'btn-primary' : ''}`}
          onClick={toggle}
          aria-pressed={!!status?.config.enabled}
          title="Simulate every call as 2 lots of the named NIFTY option, filled at live bid/ask. No orders are sent."
        >
          Auto paper trading: {status?.config.enabled ? 'ON' : 'OFF'}
        </button>
        <span className={`paper-state paper-state-${status?.state ?? 'off'}`}>
          {status ? STATE_TEXT[status.state] : '…'}
          {status?.message ? ` · ${status.message}` : ''}
        </span>
        <label className="paper-expiry">
          Expiry
          <select
            value={status?.config.expiry ?? 'nearest'}
            onChange={(e) => setExpiry(e.target.value as PaperConfig['expiry'])}
          >
            <option value="nearest">Nearest</option>
            <option value="skip-expiry-day">Next one on expiry day</option>
          </select>
        </label>
        <span className="toolbar-spacer" />
        <div className="tf-group" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r.id}
              className={`tf-btn ${r.id === range ? 'tf-btn-on' : ''}`}
              onClick={() => setRange(r.id)}
              aria-pressed={r.id === range}
            >
              {r.label}
            </button>
          ))}
        </div>
        <a className="btn btn-ghost btn-sm" href={`/api/paper/trades.csv?${q}`} download>
          CSV
        </a>
      </div>

      {open && (
        <p className="paper-open">
          Open: BUY 2 × NIFTY {open.optionName} {open.expiry ? `(${open.expiry})` : ''} at{' '}
          {num(open.entryOpt)} · index {num(open.entryIndex)}, SL {num(open.slIndex)} · since{' '}
          {hm(open.entryAt)}
          {open.lot1 ? ` · lot 1 out ${open.lot1.reason}` : ''}
        </p>
      )}

      {m && (
        <>
          <div className="paper-cards">
            <div className="paper-card">
              <span>Net (after costs)</span>
              <b className={tone(m.netRs)}>{rs(m.netRs)}</b>
              <small>
                gross {rs(m.grossRs)} · costs {rs(m.costsRs)}
              </small>
            </div>
            <div className="paper-card">
              <span>Trades</span>
              <b>{m.trades}</b>
              <small>
                {m.wins} won · {m.losses} lost · {pct(m.winRate)}
              </small>
            </div>
            <div className="paper-card">
              <span>Expectancy / trade</span>
              <b className={tone(m.expectancyRs)}>{rs(m.expectancyRs)}</b>
              <small>script {num(m.expectancyPts)} pts</small>
            </div>
            <div className="paper-card">
              <span>Profit factor</span>
              <b>{num(m.profitFactor)}</b>
              <small>
                avg win {rs(m.avgWinRs)} · avg loss {rs(m.avgLossRs)}
              </small>
            </div>
            <div className="paper-card">
              <span>Max drawdown</span>
              <b className={m.maxDrawdownRs > 0 ? 'down' : ''}>{rs(m.maxDrawdownRs)}</b>
              <small>worst losing streak {m.maxConsecutiveLosses}</small>
            </div>
            <div className="paper-card">
              <span>Days</span>
              <b>
                {m.greenDays}/{m.days} green
              </b>
              <small>
                best {rs(m.bestDayRs)} · worst {rs(m.worstDayRs)} · Sharpe {num(m.sharpe)}
              </small>
            </div>
            <div className="paper-card">
              <span>Script result</span>
              <b className={tone(m.scriptPts)}>{num(m.scriptPts)} pts</b>
              <small>{rs(m.scriptRs)} at the script&apos;s lot size</small>
            </div>
            <div className="paper-card">
              <span>Move kept</span>
              <b>{pct(m.captureRatio)}</b>
              <small>
                avg peak +{num(m.avgPeakPts)} · avg against −{num(m.avgMaePts)} pts
              </small>
            </div>
            <div className="paper-card">
              <span>Option vs index</span>
              <b>{num(m.realisedDelta)} delta</b>
              <small>
                spread paid {num(m.avgEntrySpread)} · {m.missingOptionPrices} without prices
              </small>
            </div>
            <div className="paper-card">
              <span>Rules</span>
              <b>{pct(m.bookRate)} booked</b>
              <small>
                both-lot SL {pct(m.bothSlRate)} · {num(m.avgMinutesInTrade, 0)} min avg
              </small>
            </div>
          </div>
          <div className="paper-grid">
            <div>
              <h4>Equity (net ₹)</h4>
              <Equity points={m.equity} />
            </div>
            <Counts title="Lot 1 exit" counts={m.lot1Exits} />
            <Counts title="Lot 2 exit" counts={m.lot2Exits} />
            <Breakdown title="Direction" rows={m.byDirection} />
            <Breakdown title="Source" rows={m.bySource} />
            <Breakdown title="Entry hour" rows={m.byHour} />
            {range !== 'today' && <Breakdown title="Day" rows={m.byDay} />}
            {m.bySettings.length > 1 && <Breakdown title="Settings version" rows={m.bySettings} />}
          </div>
        </>
      )}

      <table className="b2b-table paper-trades">
        <tbody>
          <tr className="b2b-sub">
            {[
              'Day',
              'In',
              'Option',
              'Expiry',
              'Index in',
              'Opt in',
              'Lot 1 out',
              'Lot 2 out',
              'Peak',
              'Script pts',
              'Net ₹',
              'Costs',
              'Notes',
            ].map((h) => (
              <td key={h}>{h}</td>
            ))}
          </tr>
          {trades.length === 0 && (
            <tr className="b2b-row-none">
              <td colSpan={13} className="b2b-muted">
                No paper trades in this period yet.
              </td>
            </tr>
          )}
          {[...trades].reverse().map((t) => (
            <tr
              key={t.id}
              className={`b2b-row-${t.status === 'open' ? 'sub' : (t.netRs ?? t.scriptRs ?? 0) >= 0 ? 'win' : 'loss'}`}
            >
              <td>{t.day.slice(5)}</td>
              <td>{hm(t.entryAt)}</td>
              <td className={t.dir === 1 ? 'b2b-up' : 'b2b-down'}>
                BUY {t.optionName}
                {t.source !== 'block' ? ` (${t.source})` : ''}
              </td>
              <td>{t.expiry?.slice(5) ?? '–'}</td>
              <td>{num(t.entryIndex)}</td>
              <td>{num(t.entryOpt)}</td>
              <td>{t.lot1 ? `${hm(t.lot1.at)} ${t.lot1.reason} @${num(t.lot1.opt)}` : 'open'}</td>
              <td>{t.lot2 ? `${hm(t.lot2.at)} ${t.lot2.reason} @${num(t.lot2.opt)}` : 'open'}</td>
              <td>+{num(t.peakPts)}</td>
              <td>{num(t.scriptPts)}</td>
              <td className={`b2b-${(t.netRs ?? 0) >= 0 ? 'up' : 'down'}`}>{rs(t.netRs)}</td>
              <td>{rs(t.costsRs)}</td>
              <td className="b2b-muted">{t.notes.join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
