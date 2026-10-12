import type { ModeInfo, ModeSwitchRequest } from '@otv/shared';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { liveClient } from '../live/liveClient';

const SPEEDS = [1, 2, 5, 10, 30];

async function waitForMode(mode: string, timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const m = await api.get<ModeInfo>('/api/mode');
      if (m.mode === mode) return true;
    } catch {
      // Server restarting.
    }
  }
  return false;
}

/**
 * Live ↔ mock data switch. The server restarts itself in the chosen mode (each
 * mode has its own data); the page reloads when it's back. Lasts until the
 * server is restarted from the terminal, which follows .env.
 */
export function ModeSwitch({ variant = 'pill' }: { variant?: 'pill' | 'link' }) {
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<'live' | 'mock'>('mock');
  const [marketOpen, setMarketOpen] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api
      .get<ModeInfo>('/api/mode')
      .then((m) => {
        setInfo(m);
        setTarget(m.mode === 'live' ? 'mock' : 'live');
        if (m.mock) {
          setMarketOpen(m.mock.marketOpen);
          setSpeed(m.mock.speed);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!info) return null;

  const apply = async () => {
    const req: ModeSwitchRequest =
      target === 'mock' ? { mode: 'mock', marketOpen, speed } : { mode: 'live' };
    setError(null);
    setBusy(target === 'live' ? 'Switching to live Kite data…' : 'Switching to mock data…');
    try {
      await api.post('/api/mode', req);
      liveClient.stop();
      if (await waitForMode(target)) window.location.reload();
      else {
        setBusy(null);
        setError('The server did not come back. Check the terminal.');
      }
    } catch (err) {
      setBusy(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const isMock = info.mode === 'mock';
  return (
    <div className="menu mode-switch" ref={ref}>
      {variant === 'pill' ? (
        <button
          className={`mode-pill ${isMock ? 'mode-mock' : 'mode-live'}`}
          onClick={() => setOpen(!open)}
          title="Switch between live Kite data and mock data"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          {isMock
            ? `MOCK DATA${info.mock && info.mock.speed !== 1 ? ` ×${info.mock.speed}` : ''}`
            : 'LIVE DATA'}
          <span aria-hidden="true">▾</span>
        </button>
      ) : (
        <button className="btn btn-ghost mode-link" onClick={() => setOpen(!open)}>
          {isMock ? 'Using mock data. Switch to live…' : 'Use mock data instead…'}
        </button>
      )}
      {open && (
        <div
          className={`mode-pop ${variant === 'link' ? 'mode-pop-up' : ''}`}
          role="dialog"
          aria-label="Data source"
        >
          <strong>Data source</strong>
          <label className={`mode-opt ${!info.liveAvailable ? 'disabled' : ''}`}>
            <input
              type="radio"
              name="mode"
              checked={target === 'live'}
              disabled={!info.liveAvailable}
              onChange={() => setTarget('live')}
            />
            <span>
              Live (Zerodha Kite)
              <small className="muted">
                {info.liveAvailable
                  ? 'Real market data. Needs the daily Zerodha login.'
                  : 'Add KITE_API_KEY and KITE_API_SECRET to .env and restart.'}
              </small>
            </span>
          </label>
          <label className="mode-opt">
            <input
              type="radio"
              name="mode"
              checked={target === 'mock'}
              onChange={() => setTarget('mock')}
            />
            <span>
              Mock
              <small className="muted">
                Simulated instruments and ticks. Nothing here is real.
              </small>
            </span>
          </label>
          {target === 'mock' && (
            <div className="mode-mock-opts">
              <label>
                <input
                  type="checkbox"
                  checked={marketOpen}
                  onChange={(e) => setMarketOpen(e.target.checked)}
                />
                As if the market is open
              </label>
              <label>
                Speed
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {error && <div className="notice notice-warn">{error}</div>}
          <p className="fineprint">
            Restarts the local server in that mode. The next start from the terminal follows .env.
          </p>
          <button
            className="btn btn-primary"
            disabled={
              !!busy ||
              (target === info.mode &&
                (target === 'live' ||
                  (info.mock?.speed === speed && info.mock?.marketOpen === marketOpen)))
            }
            onClick={() => void apply()}
          >
            {target === info.mode ? 'Apply' : `Switch to ${target}`}
          </button>
        </div>
      )}
      {busy && (
        <div className="mode-busy" role="status">
          <div className="spinner" />
          <p>{busy}</p>
        </div>
      )}
    </div>
  );
}
