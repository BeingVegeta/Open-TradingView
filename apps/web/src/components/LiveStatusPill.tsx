import { formatIstDateTime, instrumentPhase, type Instrument } from '@otv/shared';
import { useLive } from '../live/liveClient';
import { useMarketNow } from '../live/useMarketNow';
import { useWorkspace } from '../workspace/workspaceStore';

type Tone = 'ok' | 'idle' | 'warn' | 'bad';

const NSE_INDEX: Pick<Instrument, 'exchange' | 'segment'> = { exchange: 'NSE', segment: 'INDICES' };
export const PHASE_LABEL = {
  open: 'Open',
  'pre-open': 'Pre-open',
  'closing-auction': 'Closing auction',
  closed: 'Market closed',
} as const;

/**
 * Connection status: browser ↔ local server, and server ↔ Kite ticker.
 * In mock/replay mode also shows the simulated market clock. The market
 * phase follows the active chart's instrument.
 */
export function LiveStatusPill({ mock }: { mock: boolean }) {
  const { conn, live } = useLive();
  const { now, marketNow, speed } = useMarketNow();
  // The active chart's market: F&O trades until 15:40, MCX into the evening.
  const active = useWorkspace((s) => s.instruments[s.active] ?? null);
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
    const phase = instrumentPhase(active ?? NSE_INDEX, marketNow);
    if (fresh && phase === 'open') {
      tone = 'ok';
      label = 'Live';
    } else if (phase === 'open') {
      tone = 'warn';
      label = 'No ticks';
    } else {
      tone = 'idle';
      label = PHASE_LABEL[phase];
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
