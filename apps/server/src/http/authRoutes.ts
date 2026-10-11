import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService';
import type { Config } from '../config';
import { MockKiteGateway, MOCK_LOGIN_PATH } from '../kite/mockGateway';
import type { KiteGateway } from '../kite/gateway';

interface CallbackQuery {
  request_token?: string;
  status?: string;
  action?: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { config: Config; auth: AuthService; gateway: KiteGateway },
): void {
  const { config, auth, gateway } = deps;

  app.get('/api/auth/status', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return auth.status();
  });

  /** One click: the browser navigates here and is bounced to the Zerodha login page. */
  app.get('/api/auth/login', async (_req, reply) => {
    return reply.redirect(auth.loginUrl(), 302);
  });

  /**
   * The redirect URL registered with Kite. Zerodha sends the browser here with
   * `?request_token=…&action=login&status=success`.
   */
  app.get<{ Querystring: CallbackQuery }>('/api/auth/callback', async (req, reply) => {
    const { request_token: requestToken, status } = req.query;
    if (status !== 'success' || !requestToken) {
      auth.loginFailed(
        status && status !== 'success'
          ? `Zerodha login returned status "${status}".`
          : 'The login redirect did not include a request_token.',
      );
    } else {
      await auth.completeLogin(requestToken);
    }
    reply.header('cache-control', 'no-store');
    return reply.redirect(`${config.appUrl}/`, 302);
  });

  app.post('/api/auth/logout', async () => {
    await auth.logout();
    return auth.status();
  });

  if (gateway instanceof MockKiteGateway) {
    // Stands in for the Zerodha login page in mock mode.
    app.get(MOCK_LOGIN_PATH, async (_req, reply) => {
      const callback = new URL(config.redirectUrl);
      callback.searchParams.set('action', 'login');
      callback.searchParams.set('status', 'success');
      callback.searchParams.set('request_token', gateway.newRequestToken());
      return reply.redirect(callback.toString(), 302);
    });
  }
}
