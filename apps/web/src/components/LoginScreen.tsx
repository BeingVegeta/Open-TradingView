import type { AuthStatus } from '@otv/shared';
import { startLogin } from '../auth/authStore';
import { APP_NAME } from '../brand';
import { Logo } from './Logo';

type LoggedOut = Extract<AuthStatus, { state: 'logged_out' }>;

function reasonText(s: LoggedOut): { tone: 'info' | 'warn'; text: string } | null {
  switch (s.reason) {
    case 'expired':
      return {
        tone: 'info',
        text: 'Your Kite session ended at 06:00 IST. Zerodha requires a fresh login every trading day.',
      };
    case 'token_rejected':
      return {
        tone: 'warn',
        text: `Kite ended the session early${s.message ? ` (${s.message})` : ''}. This happens after a logout from Kite web or a new login elsewhere with this API key.`,
      };
    case 'login_failed':
      return { tone: 'warn', text: `Login didn't complete: ${s.message ?? 'unknown error'}` };
    case 'api_key_changed':
      return {
        tone: 'info',
        text: 'The API key changed since the last login. Log in again for the new key.',
      };
    default:
      return null;
  }
}

export function LoginScreen({ status }: { status: LoggedOut }) {
  const reason = reasonText(status);
  const mock = status.mode === 'mock';
  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand">
          <Logo size={34} />
          <span>{APP_NAME}</span>
        </div>
        <h1>{mock ? 'Mock market' : 'Connect to Kite'}</h1>
        <p className="muted">
          {mock
            ? 'Running with KITE_MODE=mock: generated instruments and ticks, no Zerodha account needed.'
            : 'Log in with your Zerodha account to stream live market data. The session lasts until 06:00 IST tomorrow.'}
        </p>
        {reason && <div className={`notice notice-${reason.tone}`}>{reason.text}</div>}
        <button className="btn btn-primary btn-lg" onClick={startLogin} autoFocus>
          {mock ? 'Enter with mock data' : 'Log in with Zerodha'}
        </button>
        <p className="fineprint">
          Read-only: this app never places orders. Your API secret and access token stay on this
          machine's server and are never sent to the browser.
        </p>
      </div>
    </main>
  );
}
