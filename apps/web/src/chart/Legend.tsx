import {
  formatIstDateTime,
  hasVolume,
  priceDecimals,
  type Candle,
  type Instrument,
} from '@otv/shared';
import { useState } from 'react';
import { formatPrice, formatQty } from '../format';
import { useWorkspace, type IndicatorConfig } from '../workspace/workspaceStore';
import { INDICATOR_DEFS, indicatorLabel } from './indicatorDefs';

export interface LegendData {
  candle: Candle | null;
  prev: Candle | null;
  indicators: {
    cfg: IndicatorConfig;
    values: { name: string; color: string; value: number | null }[];
  }[];
  hovering: boolean;
}

function Settings({
  chart,
  cfg,
  onClose,
}: {
  chart: number;
  cfg: IndicatorConfig;
  onClose: () => void;
}) {
  const list = useWorkspace((s) => s.charts[chart]!.indicators);
  const setIndicators = useWorkspace((s) => s.setIndicators);
  const def = INDICATOR_DEFS[cfg.type];
  const patch = (p: Partial<IndicatorConfig>) =>
    setIndicators(
      list.map((i) => (i.id === cfg.id ? { ...i, ...p } : i)),
      chart,
    );
  return (
    <div className="ind-settings" onMouseDown={(e) => e.stopPropagation()}>
      {def.params.map((p) => (
        <label key={p.key}>
          {p.label}
          <input
            type="number"
            min={p.min}
            max={p.max}
            step={p.step ?? 1}
            defaultValue={cfg[p.key] ?? def.defaults[p.key]}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= p.min && v <= p.max) patch({ [p.key]: v });
            }}
          />
        </label>
      ))}
      <label>
        Colour
        <input
          type="color"
          value={cfg.color ?? def.defaults.color ?? '#94a3b8'}
          onChange={(e) => patch({ color: e.target.value })}
        />
      </label>
      <button className="btn" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

/** Top-left chart legend: OHLC of the bar under the crosshair (or the newest), and indicator values. */
export function Legend({
  chart,
  instrument,
  tfLabel,
  data,
}: {
  chart: number;
  instrument: Instrument;
  tfLabel: string;
  data: LegendData;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const list = useWorkspace((s) => s.charts[chart]!.indicators);
  const setIndicators = useWorkspace((s) => s.setIndicators);
  const d = Math.max(2, priceDecimals(instrument.tickSize > 0 ? instrument.tickSize : 0.05));
  const c = data.candle;
  const chg = c && data.prev ? c.close - data.prev.close : null;
  const dir = chg === null ? '' : chg > 0 ? 'up' : chg < 0 ? 'down' : '';
  const fmt = (v: number) => formatPrice(v, d);

  return (
    <div className="legend">
      <div className="legend-row legend-ohlc">
        <span className="legend-sym">
          {instrument.tradingsymbol} · {tfLabel} · {instrument.exchange}
        </span>
        {c && (
          <>
            <span>
              O<b className={dir}>{fmt(c.open)}</b>
            </span>
            <span>
              H<b className={dir}>{fmt(c.high)}</b>
            </span>
            <span>
              L<b className={dir}>{fmt(c.low)}</b>
            </span>
            <span>
              C<b className={dir}>{fmt(c.close)}</b>
            </span>
            {chg !== null && data.prev && (
              <b className={dir}>
                {formatPrice(chg, d, true)} ({chg > 0 ? '+' : ''}
                {((chg / data.prev.close) * 100).toFixed(2)}%)
              </b>
            )}
            {hasVolume(instrument) && (
              <span>
                Vol<b>{formatQty(c.volume)}</b>
              </span>
            )}
            {c.oi ? (
              <span>
                OI<b>{formatQty(c.oi)}</b>
              </span>
            ) : null}
            {data.hovering && (
              <span className="muted legend-time">
                {formatIstDateTime(c.time * 1000).slice(0, 16)} IST
              </span>
            )}
          </>
        )}
      </div>
      {data.indicators.map(({ cfg, values }) => {
        const unavailable = INDICATOR_DEFS[cfg.type].derivativeOnly && !values.length;
        return (
          <div key={cfg.id} className="legend-row legend-ind">
            <button
              className="legend-name"
              style={{ color: cfg.color }}
              onClick={() => setEditing(editing === cfg.id ? null : cfg.id)}
              title="Settings"
            >
              {indicatorLabel(cfg)}
            </button>
            {unavailable ? (
              <span className="muted">futures &amp; options only</span>
            ) : (
              values.map((v) => (
                <b key={v.name} style={{ color: v.color }} title={v.name}>
                  {v.value === null
                    ? '—'
                    : cfg.type === 'oi'
                      ? formatQty(v.value)
                      : formatPrice(v.value, cfg.type === 'rsi' ? 2 : d)}
                </b>
              ))
            )}
            <button
              className="legend-x"
              title="Remove"
              onClick={() =>
                setIndicators(
                  list.filter((i) => i.id !== cfg.id),
                  chart,
                )
              }
              aria-label={`Remove ${indicatorLabel(cfg)}`}
            >
              ×
            </button>
            {editing === cfg.id && (
              <Settings chart={chart} cfg={cfg} onClose={() => setEditing(null)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
