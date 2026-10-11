import type { ApiErrorBody } from '@otv/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Called when the server says the Kite session is gone, so the app can show the login screen. */
let onLoggedOut: (() => void) | undefined;
export function setLoggedOutHandler(fn: () => void): void {
  onLoggedOut = fn;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  };
  if (method !== 'GET') {
    // The server only accepts JSON for state-changing requests (see server guards).
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, 'server_unreachable', 'Cannot reach the local server. Is it running?');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const d = (data ?? {}) as Partial<ApiErrorBody>;
    if (res.status === 401 && d.error === 'logged_out') onLoggedOut?.();
    throw new ApiError(
      res.status,
      d.error ?? 'http_error',
      d.message ?? `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};

export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  return u.toString();
}
