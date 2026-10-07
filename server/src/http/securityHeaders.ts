import type { MiddlewareHandler } from 'hono';

/**
 * Headers for every response. The CSP fits the dashboard bundle (same-origin
 * scripts, inline style attributes from React) and blocks everything else.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(opts: { hsts: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', CSP);
    if (opts.hsts) c.header('Strict-Transport-Security', 'max-age=31536000');
  };
}
