import {
  priceDecimals,
  type Instrument,
  type InstrumentSearchResponse,
  type Quote,
  type Watchlist as WatchlistT,
} from '@otv/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '../api';
import { formatPrice } from '../format';
import { failure, notify } from '../components/Toasts';
import { useWorkspace } from '../workspace/workspaceStore';
import { useQuotes } from './useQuotes';

function useWatchlists() {
  const [lists, setLists] = useState<WatchlistT[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      api
        .get<WatchlistT[]>('/api/watchlists')
        .then((l) => {
          setLists(l);
          setError(null);
        })
        .catch((e: unknown) => setError(failure("Couldn't load watchlists", e))),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { lists, setLists, reload, error };
}

/** Price cell that flashes green/red when the price moves. */
function PriceCell({ q, decimals }: { q: Quote | undefined; decimals: number }) {
  const prev = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState<'' | 'up' | 'down'>('');
  const price = q?.lastPrice;
  useEffect(() => {
    if (price === undefined) return;
    const p = prev.current;
    prev.current = price;
    if (p === undefined || p === price) return;
    setFlash(price > p ? 'up' : 'down');
    const t = window.setTimeout(() => setFlash(''), 300);
    return () => window.clearTimeout(t);
  }, [price]);
  return (
    <span className={`wl-ltp flash-${flash}`}>
      {price === undefined ? '—' : formatPrice(price, decimals)}
    </span>
  );
}

function AddSymbol({ onAdd }: { onAdd: (i: Instrument) => void }) {
  const [q, setQ] = useState('');
  // Results with the query they answer, so Enter never adds a stale match.
  const [answer, setAnswer] = useState<{ for: string; results: Instrument[] }>({
    for: '',
    results: [],
  });
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!q.trim()) return;
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      api
        .get<InstrumentSearchResponse>(`/api/instruments/search?${qs({ q, limit: 8 })}`, ac.signal)
        .then((r) => {
          setAnswer({ for: q, results: r.results });
          setActive(0);
        })
        .catch(() => {}); // the search box simply shows no matches
    }, 60);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [q]);
  const shown = q.trim() && answer.for === q ? answer.results : [];
  const pick = (i: Instrument | undefined) => {
    if (!i) return;
    onAdd(i);
    setQ('');
  };
  return (
    <div className="wl-add">
      <input
        className="search-input"
        placeholder="Add symbol…"
        value={q}
        spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, shown.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter') pick(shown[active]);
          else if (e.key === 'Escape') setQ('');
        }}
        aria-label="Add symbol to watchlist"
      />
      {shown.length > 0 && (
        <ul className="wl-add-results">
          {shown.map((i, idx) => (
            <li
              key={i.key}
              className={idx === active ? 'active' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(idx)}
              onClick={() => pick(i)}
            >
              <span className="search-sym">{i.tradingsymbol}</span>
              <span className="search-ex">{i.exchange}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Watchlist() {
  const { lists, setLists, reload, error } = useWatchlists();
  const layout = useWorkspace((s) => s.layout);
  const setLayout = useWorkspace((s) => s.setLayout);
  const current = useWorkspace((s) => s.charts[s.active]!.key);
  const [renaming, setRenaming] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const list = lists?.find((l) => l.id === layout.watchlistId) ?? lists?.[0];
  const items = list?.items ?? [];
  const quotes = useQuotes(items, 'quote');
  const [meta, setMeta] = useState<Map<string, Instrument>>(() => new Map());

  // Instrument details (for tick-size decimals and opening charts). Unknown keys
  // (e.g. while the instrument list downloads) are retried every few seconds.
  const itemSig = items.join('\n');
  const [lookupRound, setLookupRound] = useState(0);
  useEffect(() => {
    const missing = itemSig ? itemSig.split('\n').filter((k) => !meta.has(k)) : [];
    if (!missing.length) return;
    let cancelled = false;
    let timer: number | undefined;
    void Promise.all(
      missing.map((k) =>
        api
          .get<Instrument>(`/api/instruments/lookup?key=${encodeURIComponent(k)}`)
          .catch(() => null),
      ),
    ).then((found) => {
      if (cancelled) return;
      const hits = found.filter((i): i is Instrument => !!i);
      if (hits.length) {
        setMeta((prev) => {
          const next = new Map(prev);
          for (const i of hits) next.set(i.key, i);
          return next;
        });
      }
      if (hits.length < missing.length)
        timer = window.setTimeout(() => setLookupRound((n) => n + 1), 3000);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [itemSig, meta, lookupRound]);

  const save = async (patch: Partial<WatchlistT>) => {
    if (!list) return;
    const optimistic = { ...list, ...patch };
    setLists((ls) => ls?.map((l) => (l.id === list.id ? optimistic : l)) ?? null);
    const saved = await api
      .patch<WatchlistT>(`/api/watchlists/${list.id}`, patch)
      .catch((e: unknown) => {
        notify(failure("Couldn't save the watchlist", e));
        return null;
      });
    if (saved) setLists((ls) => ls?.map((l) => (l.id === saved.id ? saved : l)) ?? null);
    else void reload(); // put back what the server has
  };

  const addList = async () => {
    const w = await api
      .post<WatchlistT>('/api/watchlists', { name: `Watchlist ${(lists?.length ?? 0) + 1}` })
      .catch((e: unknown) => {
        notify(failure("Couldn't create the watchlist", e));
        return null;
      });
    if (!w) return;
    setLists((ls) => [...(ls ?? []), w]);
    setLayout({ watchlistId: w.id });
    setRenaming(true);
  };

  const removeList = async () => {
    if (!list || !window.confirm(`Delete watchlist "${list.name}"?`)) return;
    const rest = await api.del<WatchlistT[]>(`/api/watchlists/${list.id}`).catch((e: unknown) => {
      notify(failure("Couldn't delete the watchlist", e));
      return null;
    });
    if (rest) {
      setLists(rest);
      setLayout({ watchlistId: rest[0]?.id ?? null });
    }
  };

  const move = (from: string, to: string) => {
    if (from === to) return;
    const next = items.filter((k) => k !== from);
    next.splice(next.indexOf(to), 0, from);
    void save({ items: next });
  };

  if (error)
    return (
      <div className="panel-empty">
        <p className="muted">{error}</p>
        <button className="btn btn-sm" onClick={() => void reload()}>
          Retry
        </button>
      </div>
    );
  if (!lists) return <div className="panel-empty muted">Loading…</div>;

  return (
    <section className="wl">
      <header className="panel-head">
        {renaming && list ? (
          <input
            className="wl-rename"
            autoFocus
            defaultValue={list.name}
            onBlur={(e) => {
              setRenaming(false);
              void save({ name: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <select
            className="wl-select"
            value={list?.id}
            onChange={(e) => setLayout({ watchlistId: Number(e.target.value) })}
            onDoubleClick={() => setRenaming(true)}
            title="Double-click to rename"
            aria-label="Watchlist"
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <button
          className="icon-btn"
          title="Rename"
          onClick={() => setRenaming(true)}
          aria-label="Rename watchlist"
        >
          ✎
        </button>
        <button
          className="icon-btn"
          title="New watchlist"
          onClick={() => void addList()}
          aria-label="New watchlist"
        >
          +
        </button>
        <button
          className="icon-btn"
          title="Delete watchlist"
          onClick={() => void removeList()}
          aria-label="Delete watchlist"
        >
          🗑
        </button>
      </header>
      <AddSymbol onAdd={(i) => !items.includes(i.key) && void save({ items: [...items, i.key] })} />
      <div className="wl-cols muted">
        <span>Symbol</span>
        <span>Last</span>
        <span>Chg</span>
        <span>Chg%</span>
      </div>
      <ul className="wl-rows">
        {items.map((k) => {
          const q = quotes.get(k);
          const inst = meta.get(k);
          const decimals = inst ? Math.max(2, priceDecimals(inst.tickSize)) : 2;
          const dir =
            q?.change === undefined ? '' : q.change > 0 ? 'up' : q.change < 0 ? 'down' : '';
          return (
            <li
              key={k}
              className={`wl-row ${k === current ? 'wl-row-on' : ''} ${dragKey === k ? 'dragging' : ''}`}
              draggable
              onDragStart={() => setDragKey(k)}
              onDragEnd={() => setDragKey(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dragKey && move(dragKey, k)}
              onClick={() => inst && useWorkspace.getState().setInstrument(inst)}
              title={inst?.name ?? k}
            >
              <span className="wl-sym">
                {inst?.tradingsymbol ?? k.split(':')[1]}
                <small>{k.split(':')[0]}</small>
              </span>
              <PriceCell q={q} decimals={decimals} />
              <span className={`wl-chg ${dir}`}>
                {q?.change === undefined ? '' : formatPrice(q.change, decimals, true)}
              </span>
              <span className={`wl-pct ${dir}`}>
                {q?.changePct === undefined
                  ? ''
                  : `${q.changePct > 0 ? '+' : ''}${q.changePct.toFixed(2)}%`}
              </span>
              <button
                className="wl-remove"
                title="Remove"
                aria-label={`Remove ${k}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void save({ items: items.filter((x) => x !== k) });
                }}
              >
                ×
              </button>
            </li>
          );
        })}
        {!items.length && <li className="panel-empty muted">Empty. Add symbols above.</li>}
      </ul>
    </section>
  );
}
