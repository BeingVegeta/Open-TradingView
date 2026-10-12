import {
  instrumentKind,
  type Instrument,
  type InstrumentSearchResponse,
  type InstrumentSyncStatus,
} from '@otv/shared';
import { useEffect, useRef, useState } from 'react';
import { api, qs } from '../api';
import { useWorkspace } from '../workspace/workspaceStore';
import { failure } from './Toasts';

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'equity', label: 'Stocks' },
  { id: 'index', label: 'Indices' },
  { id: 'future', label: 'Futures' },
  { id: 'option', label: 'Options' },
  { id: 'commodity', label: 'Commodity' },
  { id: 'currency', label: 'Currency' },
] as const;

const KIND_LABEL: Record<string, string> = {
  equity: 'EQ',
  index: 'INDEX',
  future: 'FUT',
  option: 'OPT',
  other: '',
};

function describe(i: Instrument): string {
  const kind = instrumentKind(i);
  if (kind === 'option') return `${i.name} ${i.expiry ?? ''} ${i.strike} ${i.instrumentType}`;
  if (kind === 'future') return `${i.name} ${i.expiry ?? ''}`;
  return i.name;
}

export function SymbolSearch() {
  const setInstrument = useWorkspace((s) => s.setInstrument);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  /** Results and the query/filter they answer; older ones are never shown or chosen. */
  const [answer, setAnswer] = useState<{ for: string; results: Instrument[] }>({
    for: '',
    results: [],
  });
  const asked = `${filter}|${query}`;
  const results = answer.for === asked ? answer.results : [];
  const searching = answer.for !== asked;
  const [sync, setSync] = useState<InstrumentSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /** Bumped to re-run the search while the instrument list is still downloading. */
  const [retry, setRetry] = useState(0);

  // From anywhere (except while typing in a field): "/" focuses search, and
  // typing a letter starts a search with it, for the active chart.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        setQuery(e.key.toUpperCase());
        setOpen(true);
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    let retryTimer: number | undefined;
    const t = window.setTimeout(() => {
      api
        .get<InstrumentSearchResponse>(
          `/api/instruments/search?${qs({ q: query, kind: filter || undefined, limit: 40 })}`,
          ac.signal,
        )
        .then((r) => {
          setError(null);
          setAnswer({ for: `${filter}|${query}`, results: r.results });
          setSync(r.sync);
          setActive(0);
          if (r.sync.count === 0 && !r.sync.error)
            retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 1000);
        })
        .catch((e: unknown) => {
          if (!ac.signal.aborted) setError(failure('Search failed', e));
        });
    }, 60);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(retryTimer);
      ac.abort();
    };
  }, [query, filter, open, retry]);

  const choose = (i: Instrument) => {
    setInstrument(i);
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const syncing = sync && sync.count === 0;

  return (
    <div
      className="search"
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
    >
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Search symbol (type or press /)"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search instruments"
      />
      {open && (
        <div className="search-pop" tabIndex={-1}>
          <div className="search-filters">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`chip ${filter === f.id ? 'chip-on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {error && <div className="search-msg notice-warn">{error}</div>}
          {sync?.error && <div className="search-msg notice-warn">{sync.error}</div>}
          {syncing && !sync.error && (
            <div className="search-msg muted">
              {sync.syncing
                ? 'Downloading the instrument list from Kite…'
                : 'Instrument list not downloaded yet.'}
            </div>
          )}
          {!error && !syncing && !searching && query.trim() && results.length === 0 && (
            <div className="search-msg muted">No matches</div>
          )}
          {!query.trim() && !syncing && (
            <div className="search-msg muted">
              Type a symbol or name, e.g. RELIANCE, NIFTY 50, NSE:INFY, nifty fut
            </div>
          )}
          <ul className="search-results" role="listbox">
            {results.map((i, idx) => (
              <li
                key={i.key}
                role="option"
                aria-selected={idx === active}
                className={`search-row ${idx === active ? 'search-row-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(idx)}
                onClick={() => choose(i)}
              >
                <span className="search-sym">{i.tradingsymbol}</span>
                <span className="search-name">{describe(i)}</span>
                <span className="search-kind">{KIND_LABEL[instrumentKind(i)]}</span>
                <span className="search-ex">{i.exchange}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
