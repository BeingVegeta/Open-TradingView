import {
  instrumentKind,
  type Instrument,
  type InstrumentSearchResponse,
  type InstrumentSyncStatus,
} from '@otv/shared';
import { useEffect, useRef, useState } from 'react';
import { api, qs } from '../api';
import { useWorkspace } from '../workspace/workspaceStore';

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
  const [results, setResults] = useState<Instrument[]>([]);
  const [sync, setSync] = useState<InstrumentSyncStatus | null>(null);
  const [active, setActive] = useState(0);

  // "/" focuses search from anywhere (except while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      api
        .get<InstrumentSearchResponse>(
          `/api/instruments/search?${qs({ q: query, kind: filter || undefined, limit: 40 })}`,
          ac.signal,
        )
        .then((r) => {
          setResults(r.results);
          setSync(r.sync);
          setActive(0);
        })
        .catch(() => {});
    }, 60);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [query, filter, open]);

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
        placeholder="Search symbol  ( / )"
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
          {sync?.error && <div className="search-msg notice-warn">{sync.error}</div>}
          {syncing && !sync.error && (
            <div className="search-msg muted">
              {sync.syncing
                ? 'Downloading the instrument list from Kite…'
                : 'Instrument list not downloaded yet.'}
            </div>
          )}
          {!syncing && query.trim() && results.length === 0 && (
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
