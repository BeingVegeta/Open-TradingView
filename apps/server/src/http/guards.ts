import type { FastifyInstance } from 'fastify';
import { isLoopbackHost, type Config } from '../config';

function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * The server is a private, single-user service on localhost. These checks stop
 * other websites open in the same browser from using it:
 *
 * - Host allow-list: defeats DNS rebinding (a hostile domain re-pointed at 127.0.0.1).
 * - State-changing requests must be JSON (cross-site forms cannot send that
 *   without a CORS preflight, which this server never approves) and, when the
 *   browser sends an Origin, it must be one of ours.
 */
export function registerGuards(app: FastifyInstance, config: Config): void {
  const allowed = new Set<string>([config.host]);
  for (const u of [config.appUrl, config.redirectUrl])
    allowed.add(new URL(u).hostname.replace(/^\[|\]$/g, ''));
  const isAllowed = (h: string) => isLoopbackHost(h) || allowed.has(h);

  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowed(hostnameOf(req.headers.host ?? ''))) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      (origin === 'null' || !isAllowed(hostnameOf(origin.replace(/^[a-z]+:\/\//i, ''))))
    ) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return reply.code(415).send({ error: 'json_required' });
    }
  });
}
