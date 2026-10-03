/**
 * Builds the Hono app from explicit dependencies. Kept apart from index.ts so
 * tests drive it with app.request() without binding a port.
 *
 *   /health, /health/ready   liveness / readiness
 *   /api/v1/*                SDK: config, reports, attachments (ingest key)
 *   /api/admin/*             dashboard API (session cookie + CSRF)
 *   /s/:token                public share links
 *   everything else          the dashboard SPA
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from './deps';
import type { AppEnv } from './http/env';
import { clientIp } from './http/clientIp';
import { errorBody, HttpError, sendError } from './http/errors';
import { securityHeaders } from './http/securityHeaders';
import { requireSession } from './http/session';
import { errorMessage, log } from './log';
import { ingestRoutes } from './routes/ingest';
import { authRoutes } from './routes/admin/auth';
import { ticketRoutes } from './routes/admin/tickets';
import { projectRoutes } from './routes/admin/projects';
import { userRoutes } from './routes/admin/users';
import { shareRoutes } from './routes/share';
import { spaRoutes } from './routes/spa';
import { VERSION } from './version';

const JSON_LIMIT = 256 * 1024;

export function buildApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('ip', clientIp(c, deps.config.trustProxy));
    await next();
  });
  app.use('*', securityHeaders({ hsts: deps.config.publicUrl.startsWith('https://') }));
  // JSON bodies are small; attachment PUTs are streamed and capped per type in the route.
  app.use('*', async (c, next) => {
    if (c.req.method === 'PUT' && /^\/api\/v1\/reports\/[^/]+\/attachments\//.test(c.req.path)) return next();
    return bodyLimit({ maxSize: JSON_LIMIT, onError: (c) => c.json(errorBody('payload_too_large', 'Request body too large'), 413) })(c, next);
  });

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }));
  app.get('/health/ready', async (c) => {
    try {
      deps.db.prepare('SELECT 1').get();
      await deps.blobs.check();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: errorMessage(e) }, 503);
    }
  });

  app.route('/api/v1', ingestRoutes(deps));

  const admin = new Hono<AppEnv>();
  admin.route('/auth', authRoutes(deps));
  admin.use('*', async (c, next) => (c.req.path.startsWith('/api/admin/auth/') ? next() : requireSession(deps)(c, next)));
  admin.route('/', ticketRoutes(deps));
  admin.route('/', projectRoutes(deps));
  admin.route('/', userRoutes(deps));
  app.route('/api/admin', admin);

  app.route('/s', shareRoutes(deps));
  app.route('/', spaRoutes(deps.config.publicDir));

  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return sendError(c, err);
    log.error('http', `unhandled error on ${c.req.method} ${c.req.path}`, { error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined });
    return c.json(errorBody('internal', 'Internal server error'), 500);
  });
  return app;
}
