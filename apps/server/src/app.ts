import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AuthService } from './auth/authService';
import { SessionStore } from './auth/sessionStore';
import type { Config } from './config';
import type { Db } from './db';
import type { KiteGateway } from './kite/gateway';
import { registerAuthRoutes } from './http/authRoutes';
import { registerGuards } from './http/guards';

export interface AppDeps {
  config: Config;
  db: Db;
  gateway: KiteGateway;
  now?: () => number;
  logger?: FastifyServerOptions['logger'];
}

export interface App {
  server: FastifyInstance;
  auth: AuthService;
}

/** Strips one-time tokens from URLs before they reach the log. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:request_token|access_token|api_secret)=)[^&#]*/gi, '$1[redacted]');
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const { config, db, gateway } = deps;
  const server = Fastify({
    logger: deps.logger ?? {
      level: config.logLevel,
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: redactUrl(req.url),
        }),
      },
    },
    // Single local user: keep request bodies small.
    bodyLimit: 1024 * 1024,
  });

  const auth = new AuthService({
    apiKey: config.apiKey,
    store: new SessionStore(db),
    gateway,
    log: server.log,
    ...(deps.now ? { now: deps.now } : {}),
  });
  server.addHook('onClose', async () => auth.dispose());

  registerGuards(server, config);

  server.get('/api/health', async () => ({ ok: true, mode: gateway.mode }));
  registerAuthRoutes(server, { config, auth, gateway });

  if (existsSync(config.webDistDir)) {
    await server.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    server.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return { server, auth };
}
