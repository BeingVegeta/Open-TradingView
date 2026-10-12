import type { Quote } from '@otv/shared';
import { useEffect, useRef, useState } from 'react';
import { liveClient } from '../live/liveClient';

/** Live quotes for a set of instruments, keyed by instrument key. */
export function useQuotes(keys: string[], detail: 'quote' | 'full'): Map<string, Quote> {
  const [quotes, setQuotes] = useState<Map<string, Quote>>(() => new Map());
  const handle = useRef<ReturnType<typeof liveClient.watch> | null>(null);
  const keySig = keys.join('\n');

  useEffect(() => {
    const h = liveClient.watch([], detail, (qs) =>
      setQuotes((prev) => {
        const next = new Map(prev);
        for (const q of qs) next.set(q.key, q);
        return next;
      }),
    );
    handle.current = h;
    return () => {
      h.close();
      handle.current = null;
    };
  }, [detail]);

  useEffect(() => {
    handle.current?.update(keySig ? keySig.split('\n') : []);
  }, [keySig, detail]);

  return quotes;
}
