export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  };
  if (method !== 'GET') {
    // The server only accepts JSON for state-changing requests (see server guards).
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'server_unreachable', 'Cannot reach the local server. Is it running?');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      d.error ?? 'http_error',
      d.message ?? `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};
