/**
 * Normalised Kite API errors.
 *
 * Kite answers errors with an HTTP status and `{ status: "error", error_type, message }`
 * (https://kite.trade/docs/connect/v3/exceptions/). The kiteconnect SDK drops the
 * status, so for SDK calls classification falls back to `error_type` and the message.
 */
export type KiteErrorKind =
  /** 403 TokenException: the session is gone. Drop it and show the login prompt. */
  | 'token'
  /** No access, e.g. market data on an API key without the paid Connect plan. Do not retry. */
  | 'permission'
  /** 400 InputException: bad parameters (e.g. a historical range larger than the interval allows). */
  | 'input'
  /** 429: over the per-endpoint rate limit. */
  | 'rate_limit'
  /** Could not reach Kite, or Kite returned a 5xx / NetworkException. Retryable. */
  | 'network'
  /** 404 / 410. */
  | 'not_found'
  | 'data'
  | 'general';

export class KiteApiError extends Error {
  override readonly name = 'KiteApiError';
  constructor(
    readonly kind: KiteErrorKind,
    message: string,
    /** Kite's `error_type`, when there was one. */
    readonly errorType?: string,
    /** HTTP status, when known. */
    readonly status?: number,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'rate_limit';
  }
}

const KIND_BY_ERROR_TYPE: Record<string, KiteErrorKind> = {
  TokenException: 'token',
  // Not in the documented exception list, but returned for calls the API key's plan
  // doesn't cover (e.g. market data without the Connect plan).
  PermissionException: 'permission',
  InputException: 'input',
  NetworkException: 'network',
  DataException: 'data',
  GeneralException: 'general',
  UserException: 'general',
};

function kindFromStatus(status: number): KiteErrorKind | undefined {
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'input';
  if (status === 404 || status === 410) return 'not_found';
  if (status >= 500) return 'network';
  return undefined;
}

function classify(errorType: string | undefined, message: string, status?: number): KiteErrorKind {
  if (status === 429 || /too many requests/i.test(message)) return 'rate_limit';
  if (errorType === 'TokenException') return 'token';
  if (/insufficient permission|not (?:enabled|subscribed)/i.test(message)) return 'permission';
  const byType = errorType ? KIND_BY_ERROR_TYPE[errorType] : undefined;
  return byType ?? (status !== undefined ? kindFromStatus(status) : undefined) ?? 'general';
}

/** Builds an error from a raw HTTP response (status + parsed JSON body, if any). */
export function kiteErrorFromHttp(status: number, body: unknown): KiteApiError {
  const b = (body && typeof body === 'object' ? body : {}) as {
    error_type?: unknown;
    message?: unknown;
  };
  const errorType = typeof b.error_type === 'string' ? b.error_type : undefined;
  const message =
    typeof b.message === 'string' && b.message ? b.message : `Kite API returned HTTP ${status}`;
  return new KiteApiError(classify(errorType, message, status), message, errorType, status);
}

export function toKiteError(err: unknown): KiteApiError {
  if (err instanceof KiteApiError) return err;
  if (err && typeof err === 'object' && 'error_type' in err) {
    const e = err as { error_type?: unknown; message?: unknown };
    const errorType = String(e.error_type);
    const message = typeof e.message === 'string' && e.message ? e.message : errorType;
    return new KiteApiError(classify(errorType, message), message, errorType);
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return new KiteApiError('network', 'Request aborted');
    return new KiteApiError('network', err.message);
  }
  return new KiteApiError('general', String(err));
}
