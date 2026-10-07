/**
 * Public share links (/s/:token): unauthenticated, revocable, optionally
 * expiring access to one attachment, for GitHub issues and chat messages.
 */
import { Hono, type Context } from 'hono';
import type { Deps } from '../deps';
import type { AppEnv } from '../http/env';
import { notFound } from '../http/errors';
import { serveBlob } from '../http/range';
import { extension } from './admin/tickets';

export function shareRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const handler = async (c: Context<AppEnv>) => {
    const a = deps.tickets.resolveShareToken(c.req.param('token')!);
    if (!a || a.state !== 'stored' || !a.storage_key) throw notFound('This link has expired or been revoked');
    return serveBlob({
      store: deps.blobs,
      key: a.storage_key,
      size: a.size_bytes ?? 0,
      contentType: a.content_type,
      method: c.req.method,
      rangeHeader: c.req.header('range'),
      filename: `${a.name}${extension(a.content_type)}`,
      // Short: a revoked link should stop working in caches soon.
      cacheControl: 'public, max-age=300',
      extraHeaders: { 'X-Robots-Tag': 'noindex, nofollow' },
    });
  };
  app.get('/:token', handler);
  app.on('HEAD', '/:token', handler);
  return app;
}
