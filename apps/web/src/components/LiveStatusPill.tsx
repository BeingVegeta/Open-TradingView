import { formatIstDateTime, marketPhase } from '@otv/shared';
import { useEffect, useState } from 'react';
import { useLive } from '../live/liveClient';

type Tone = 'ok' | 'idle' | 'warn' | 'bad';

const readClocks = () => ({ wall: Date.now(), perf: performance.now() });

/** Wall and monotonic time, refreshed every `ms`. */
function useClocks(ms: number) {
  const [t, set] = useState(readClocks);
  useEffect(() => {
    const id = window.setInterval(() => set(readClocks()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return t;
}

/**
 * Connection status: browser ↔ local server, and server ↔ Kite ticker.
 * In mock/replay mode also shows the simulated market clock.
 */
export function LiveStatusPill({ mock }: { mock: boolean }) {
  const { conn, live, liveAt } = useLive();
  const clocks = useClocks((live?.speed ?? 1) > 1 ? 250 : 1000);
  const now = clocks.wall;
  const speed = live?.speed ?? 1;
  const marketNow = live ? live.marketNow + Math.max(0, clocks.perf - liveAt) * speed : now;
  const shifted = live ? Math.abs(marketNow - now) > 60_000 || speed !== 1 : false;

  let tone: Tone;
  let label: string;
  let title: string;
  if (conn !== 'open') {
    tone = 'bad';
    label = conn === 'connecting' ? 'Connecting…' : 'Offline';
    title = 'Lost the connection to the local server; reconnecting automatically.';
  } else if (!live || live.upstream === 'idle') {
    tone = 'idle';
    label = 'Idle';
    title = 'Not streaming: no chart is open.';
  } else if (live.upstream === 'reconnecting' || live.upstream === 'connecting') {
    tone = 'warn';
    const secs = live.retryAt ? Math.max(0, Math.round((live.retryAt - now) / 1000)) : 0;
    label =
      live.upstream === 'connecting'
        ? 'Connecting to Kite…'
        : `Reconnecting${secs ? ` in ${secs}s` : '…'}`;
    title = 'The Kite live-data connection dropped; reconnecting with backoff.';
  } else if (live.upstream === 'stopped') {
    tone = 'bad';
    label = 'Stopped';
    title = 'Live data stopped (session ended).';
  } else {
    const fresh = live.lastTickAt !== null && now - live.lastTickAt < 15_000;
    const phase = marketPhase('NSE', marketNow);
    if (fresh && phase === 'open') {
      tone = 'ok';
      label = 'Live';
    } else if (phase === 'open') {
      tone = 'warn';
      label = 'No ticks';
    } else {
      tone = 'idle';
      label = phase === 'pre-open' ? 'Pre-open' : 'Market closed';
    }
    title = live.lastTickAt
      ? `Connected to Kite. Last tick ${Math.round((now - live.lastTickAt) / 1000)}s ago.`
      : 'Connected to Kite. No ticks yet.';
  }

  return (
    <span className={`live-pill live-${tone}`} title={title}>
      <span className={`dot dot-${tone}`} />
      {label}
      {(mock || shifted) && (
        <span className="muted live-clock">
          {formatIstDateTime(marketNow).slice(11, 19)} IST{speed !== 1 ? ` ×${speed}` : ''}
        </span>
      )}
    </span>
  );
}
