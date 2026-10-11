/**
 * Normalised Kite API errors.
 *
 * The kiteconnect SDK rejects with Kite's JSON error body (`{ error_type, message }`)
 * and drops the HTTP status, so classification is by `error_type`.
 */
export type KiteErrorKind =
  /** 403 TokenException: the session is gone. Drop it and show the login prompt. */
  | 'token'
  /** PermissionException: e.g. market data on an API key without the paid Connect plan. Do not retry. */
  | 'permission'
  /** InputException: bad parameters (e.g. a historical range larger than the interval allows). */
  | 'input'
  /** 429: over the per-endpoint rate limit. */
  | 'rate_limit'
  /** Could not reach Kite, or Kite returned a 5xx. Retryable. */
  | 'network'
  | 'data'
  | 'general';

export class KiteApiError extends Error {
  override readonly name = 'KiteApiError';
  constructor(
    readonly kind: KiteErrorKind,
    message: string,
    /** Kite's `error_type`, when there was one. */
    readonly errorType?: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'rate_limit';
  }
}

const KIND_BY_ERROR_TYPE: Record<string, KiteErrorKind> = {
  TokenException: 'token',
  PermissionException: 'permission',
  InputException: 'input',
  NetworkException: 'network',
  DataException: 'data',
  GeneralException: 'general',
};

export function toKiteError(err: unknown): KiteApiError {
  if (err instanceof KiteApiError) return err;
  if (err && typeof err === 'object' && 'error_type' in err) {
    const e = err as { error_type?: unknown; message?: unknown };
    const errorType = String(e.error_type);
    const message = typeof e.message === 'string' && e.message ? e.message : errorType;
    let kind = KIND_BY_ERROR_TYPE[errorType] ?? 'general';
    if (/too many requests/i.test(message)) kind = 'rate_limit';
    return new KiteApiError(kind, message, errorType);
  }
  if (err instanceof Error) return new KiteApiError('network', err.message);
  return new KiteApiError('general', String(err));
}
