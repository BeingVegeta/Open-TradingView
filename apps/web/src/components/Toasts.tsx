import { create } from 'zustand';
import { ApiError } from '../api';

interface Toast {
  id: number;
  message: string;
}

const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));
let seq = 0;

/** Shows a short message at the bottom of the screen (repeats of the same one are merged). */
export function notify(message: string): void {
  const { toasts } = useToasts.getState();
  if (toasts.some((t) => t.message === message)) return;
  const id = ++seq;
  useToasts.setState({ toasts: [...toasts.slice(-3), { id, message }] });
  window.setTimeout(() => dismiss(id), 7000);
}

function dismiss(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** "What failed: why", for a failed request. */
export function failure(what: string, err: unknown): string {
  const why = err instanceof ApiError ? err.message : err instanceof Error ? err.message : '';
  return why ? `${what}: ${why}` : what;
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.message}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
