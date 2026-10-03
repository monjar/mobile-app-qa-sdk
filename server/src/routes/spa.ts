/**
 * Serves the built dashboard: hashed assets with long caching, and index.html
 * for every other GET so client-side routes (/tickets/…) survive a reload.
 */
import { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { AppEnv } from '../http/env';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const FALLBACK = `<!doctype html><meta charset="utf-8"><title>Snitch</title>
<body style="font-family:system-ui;padding:40px;color:#333">
<h1>Snitch server is running</h1>
<p>The dashboard bundle wasn't found. Build it with <code>npm run build -w dashboard</code> or set <code>SNITCH_PUBLIC_DIR</code>.</p>
</body>`;

export function spaRoutes(publicDir: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const root = normalize(publicDir);
  const indexPath = join(root, 'index.html');

  app.get('*', (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    if (path.startsWith('/api/')) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    const file = normalize(join(root, path));
    if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      const immutable = path.startsWith('/assets/');
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
        headers: {
          'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    }
    if (!existsSync(indexPath)) return c.html(FALLBACK);
    return c.body(readFileSync(indexPath), 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });
  return app;
}
