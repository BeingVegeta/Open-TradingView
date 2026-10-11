import type { AuthStatus } from '@otv/shared';
import { create } from 'zustand';
import { api, ApiError } from '../api';

interface AuthState {
  status: AuthStatus | null;
  /** Set when the local server itself can't be reached (distinct from being logged out). */
  serverError: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  status: null,
  serverError: null,
  refresh: async () => {
    try {
      const status = await api.get<AuthStatus>('/api/auth/status');
      set({ status, serverError: null });
    } catch (err) {
      set({ serverError: err instanceof ApiError ? err.message : String(err) });
    }
  },
  logout: async () => {
    const status = await api.post<AuthStatus>('/api/auth/logout');
    set({ status });
  },
}));

/** Starts the login redirect flow: the server bounces the browser to Zerodha. */
export function startLogin(): void {
  window.location.assign('/api/auth/login');
}

/**
 * Keeps the auth state current without polling hard: re-check when the tab
 * becomes visible again (it may have slept past 06:00 IST) and right after the
 * scheduled expiry.
 */
export function watchAuth(): () => void {
  const { refresh } = useAuth.getState();
  void refresh();

  const onVisible = () => {
    if (document.visibilityState === 'visible') void refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);

  let timer: number | undefined;
  const unsubscribe = useAuth.subscribe((s) => {
    window.clearTimeout(timer);
    if (s.status?.state === 'logged_in') {
      const delay = Math.min(s.status.expiresAt - Date.now() + 1000, 2 ** 31 - 1);
      timer = window.setTimeout(() => void refresh(), Math.max(delay, 1000));
    } else if (s.serverError) {
      timer = window.setTimeout(() => void refresh(), 3000);
    }
  });

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onVisible);
    window.clearTimeout(timer);
    unsubscribe();
  };
}
