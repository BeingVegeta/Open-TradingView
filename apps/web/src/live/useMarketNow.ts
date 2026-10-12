import { useEffect, useState } from 'react';
import { useLive } from './liveClient';

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
 * The market's clock as the server runs it (the real time, or the simulated
 * time in mock and replay mode), advanced locally between status messages.
 */
export function useMarketNow() {
  const live = useLive((s) => s.live);
  const liveAt = useLive((s) => s.liveAt);
  const speed = live?.speed ?? 1;
  const clocks = useClocks(speed > 1 ? 250 : 1000);
  const now = clocks.wall;
  const marketNow = live ? live.marketNow + Math.max(0, clocks.perf - liveAt) * speed : now;
  return { now, marketNow, speed };
}
