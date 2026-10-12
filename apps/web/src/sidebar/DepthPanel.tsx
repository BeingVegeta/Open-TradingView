import { formatIstDateTime, instrumentKind, priceDecimals, type Instrument } from '@otv/shared';
import { formatPrice, formatQty } from '../format';
import { useQuotes } from './useQuotes';

/** Five-level market depth, day statistics and open interest for the chart's instrument (full-mode ticks). */
export function DepthPanel({ instrument }: { instrument: Instrument | null }) {
  const quotes = useQuotes(instrument ? [instrument.key] : [], 'full');
  if (!instrument) return <div className="panel-empty muted">No instrument</div>;
  const q = quotes.get(instrument.key);
  const kind = instrumentKind(instrument);
  const d = Math.max(2, priceDecimals(instrument.tickSize));
  const px = (v: number | undefined) => (v === undefined || v === 0 ? '—' : formatPrice(v, d));
  const derivative = kind === 'future' || kind === 'option';

  if (!q) return <div className="panel-empty muted">Waiting for data…</div>;
  const levels = q.depth;
  const maxQty = levels
    ? Math.max(1, ...levels.buy.map((l) => l.quantity), ...levels.sell.map((l) => l.quantity))
    : 1;
  const totalBuy = q.buyQuantity ?? 0;
  const totalSell = q.sellQuantity ?? 0;
  const buyShare = totalBuy + totalSell > 0 ? (totalBuy / (totalBuy + totalSell)) * 100 : 50;
  const dir = (q.change ?? 0) > 0 ? 'up' : (q.change ?? 0) < 0 ? 'down' : '';

  return (
    <section className="depth">
      <div className="depth-ltp">
        <strong className={dir}>{px(q.lastPrice)}</strong>
        {q.change !== undefined && (
          <span className={dir}>
            {formatPrice(q.change, d, true)} ({q.changePct! > 0 ? '+' : ''}
            {q.changePct!.toFixed(2)}%)
          </span>
        )}
      </div>
      {kind === 'index' ? (
        <p className="panel-empty muted">Indices have no market depth.</p>
      ) : levels ? (
        <>
          <table className="depth-book">
            <thead>
              <tr className="muted">
                <th>Bid</th>
                <th>Orders</th>
                <th>Qty</th>
                <th>Offer</th>
                <th>Orders</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {levels.buy.map((b, i) => {
                const s = levels.sell[i]!;
                return (
                  <tr key={i}>
                    <td className="up bar-cell">
                      <i
                        className="bar bar-buy"
                        style={{ width: `${(b.quantity / maxQty) * 100}%` }}
                      />
                      {px(b.price)}
                    </td>
                    <td className="muted">{b.orders || ''}</td>
                    <td>{b.quantity ? formatQty(b.quantity) : ''}</td>
                    <td className="down bar-cell">
                      <i
                        className="bar bar-sell"
                        style={{ width: `${(s.quantity / maxQty) * 100}%` }}
                      />
                      {px(s.price)}
                    </td>
                    <td className="muted">{s.orders || ''}</td>
                    <td>{s.quantity ? formatQty(s.quantity) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="depth-totals">
            <span className="up">{formatQty(totalBuy)}</span>
            <div
              className="depth-ratio"
              title={`Buy ${buyShare.toFixed(0)}% / Sell ${(100 - buyShare).toFixed(0)}%`}
            >
              <i style={{ width: `${buyShare}%` }} />
            </div>
            <span className="down">{formatQty(totalSell)}</span>
          </div>
        </>
      ) : (
        <p className="panel-empty muted">Depth appears once full-mode ticks arrive.</p>
      )}
      <dl className="depth-stats">
        <dt>Open</dt>
        <dd>{px(q.open)}</dd>
        <dt>High</dt>
        <dd>{px(q.high)}</dd>
        <dt>Low</dt>
        <dd>{px(q.low)}</dd>
        <dt>Prev close</dt>
        <dd>{px(q.prevClose)}</dd>
        {kind !== 'index' && (
          <>
            <dt>Volume</dt>
            <dd>{q.volume !== undefined ? formatQty(q.volume) : '—'}</dd>
            <dt>Avg price</dt>
            <dd>{px(q.averagePrice)}</dd>
            <dt>LTQ</dt>
            <dd>{q.lastQuantity ?? '—'}</dd>
            <dt>LTT</dt>
            <dd>{q.lastTradeTime ? formatIstDateTime(q.lastTradeTime * 1000).slice(11) : '—'}</dd>
          </>
        )}
        {derivative && (
          <>
            <dt>OI</dt>
            <dd>{q.oi !== undefined ? formatQty(q.oi) : '—'}</dd>
            <dt>OI day H/L</dt>
            <dd>
              {q.oiDayHigh ? `${formatQty(q.oiDayHigh)} / ${formatQty(q.oiDayLow ?? 0)}` : '—'}
            </dd>
            <dt>Lot size</dt>
            <dd>{instrument.lotSize}</dd>
            <dt>Expiry</dt>
            <dd>{instrument.expiry ?? '—'}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
