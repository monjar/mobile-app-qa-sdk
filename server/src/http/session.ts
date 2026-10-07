/**
 * Dashboard authentication: an HttpOnly session cookie plus a CSRF token that
 * the SPA sends back in X-CSRF-Token on every state-changing request. The
 * Origin header, when present, must match SNITCH_PUBLIC_URL.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { CSRF_HEADER } from '@snitch/contract';
import type { Deps } from '../deps';
import { safeEqual } from '../crypto/tokens';
import type { AppEnv } from './env';
import { forbidden, HttpError, unauthorized } from './errors';

export function cookieName(deps: Deps): string {
  // __Host- requires Secure; browsers reject it on plain-http localhost.
  return deps.config.cookieSecure ? '__Host-snitch_session' : 'snitch_session';
}

export function setSessionCookie(c: Context, deps: Deps, token: string, expiresAt: number): void {
  setCookie(c, cookieName(deps), token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(0, Math.floor((expiresAt - deps.now()) / 1000)),
  });
}

export function clearSessionCookie(c: Context, deps: Deps): void {
  deleteCookie(c, cookieName(deps), { path: '/', secure: deps.config.cookieSecure });
}

function originAllowed(deps: Deps, c: Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true; // same-origin fetches from older browsers, CLI tools
  const expected = new URL(deps.config.publicUrl).origin;
  if (origin === expected) return true;
  // Also accept the origin the request actually came in on (reverse proxies, localhost aliases).
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function requireSession(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, cookieName(deps));
    const found = token ? deps.sessions.lookup(token) : null;
    if (!found) throw unauthorized();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const sent = c.req.header(CSRF_HEADER) ?? '';
      if (!safeEqual(sent, found.session.csrf_token)) throw new HttpError(403, 'csrf', 'Missing or invalid CSRF token');
      if (!originAllowed(deps, c)) throw new HttpError(403, 'csrf', 'Cross-origin request refused');
    }
    c.set('user', found.user);
    c.set('session', found.session);
    await next();
  };
}

export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('user').role !== 'admin') throw forbidden('Admins only');
    await next();
  };
}
