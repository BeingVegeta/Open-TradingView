import type { AuthStatus } from '@otv/shared';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/authStore';
import { APP_NAME } from '../brand';
import { formatDuration, formatIstShort } from '../format';
import { Logo } from './Logo';

type LoggedIn = Extract<AuthStatus, { state: 'logged_in' }>;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function TopBar({ status }: { status: LoggedIn }) {
  const logout = useAuth((s) => s.logout);
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const remaining = status.expiresAt - now;

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Logo />
        <span>{APP_NAME}</span>
      </div>
      <div className="topbar-spacer" />
      {status.mode === 'mock' && (
        <span className="badge badge-mock" title="KITE_MODE=mock: synthetic data">
          MOCK DATA
        </span>
      )}
      <span
        className={`session-pill ${remaining < 60 * 60_000 ? 'session-pill-warn' : ''}`}
        title={`Kite session expires ${formatIstShort(status.expiresAt)}`}
      >
        <span className="dot dot-ok" />
        {status.user.userId}
        <span className="muted">· session {formatDuration(remaining)}</span>
      </span>
      <button
        className="btn btn-ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          logout().finally(() => setBusy(false));
        }}
      >
        Log out
      </button>
    </header>
  );
}
