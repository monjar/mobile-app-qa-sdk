/**
 * Login, logout, current user, and first-run setup.
 *
 * First run: with no users and no SNITCH_BOOTSTRAP_ADMIN_* env, the server
 * logs a one-time setup URL; whoever opens it creates the first admin. The
 * token keeps a freshly exposed server from being claimed by a stranger.
 */
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { LoginRequest, PASSWORD_MIN_LENGTH, type Me } from '@snitch/contract';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { HttpError, unauthorized } from '../../http/errors';
import { jsonBody } from '../../http/validate';
import { clearSessionCookie, cookieName, requireSession, setSessionCookie } from '../../http/session';
import { DUMMY_HASH, verifyPassword } from '../../crypto/passwords';
import { safeEqual } from '../../crypto/tokens';
import { toUserView } from '../../repo/users';

const SetupRequest = z.object({
  token: z.string().min(1).max(200),
  email: z.email().max(254),
  name: z.string().max(120).optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(512),
});

export function authRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/setup', (c) => c.json({ needed: deps.setupToken.value !== null && deps.users.count() === 0 }));

  app.post('/setup', async (c) => {
    deps.limiters.loginPerIp.enforce(c.get('ip'));
    const body = await jsonBody(c, SetupRequest);
    const token = deps.setupToken.value;
    if (!token || deps.users.count() > 0) throw new HttpError(409, 'conflict', 'Setup has already been completed');
    if (!safeEqual(body.token, token)) throw new HttpError(403, 'forbidden', 'Invalid setup token');
    const user = await deps.users.create({ email: body.email, name: body.name ?? null, role: 'admin', password: body.password });
    deps.setupToken.value = null;
    deps.audit.add(user.id, 'setup.completed', user.email, {}, c.get('ip'));
    const s = deps.sessions.create(user.id, c.get('ip'), c.req.header('user-agent') ?? null);
    setSessionCookie(c, deps, s.token, s.expiresAt);
    return c.json({ user, csrfToken: s.csrfToken } satisfies Me, 201);
  });

  app.post('/login', async (c) => {
    deps.limiters.loginPerIp.enforce(c.get('ip'), 'Too many sign-in attempts; try again later');
    const body = await jsonBody(c, LoginRequest);
    const email = body.email.trim().toLowerCase();
    deps.limiters.loginPerEmail.enforce(email, 'Too many sign-in attempts for this account; try again later');
    const user = deps.users.getByEmail(email);
    // Always run scrypt so response time doesn't reveal which emails exist.
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled_at !== null) {
      deps.audit.add(user?.id ?? null, 'login.failed', email, {}, c.get('ip'));
      throw new HttpError(401, 'unauthorized', 'Email or password is incorrect');
    }
    deps.limiters.loginPerEmail.reset(email);
    deps.users.recordLogin(user.id);
    const s = deps.sessions.create(user.id, c.get('ip'), c.req.header('user-agent') ?? null);
    setSessionCookie(c, deps, s.token, s.expiresAt);
    deps.audit.add(user.id, 'login', user.email, {}, c.get('ip'));
    return c.json({ user: toUserView({ ...user, last_login_at: deps.now() }), csrfToken: s.csrfToken } satisfies Me);
  });

  app.post('/logout', requireSession(deps), (c) => {
    const token = getCookie(c, cookieName(deps));
    if (token) deps.sessions.delete(token);
    clearSessionCookie(c, deps);
    return c.json({ ok: true });
  });

  app.get('/me', (c) => {
    const token = getCookie(c, cookieName(deps));
    const found = token ? deps.sessions.lookup(token) : null;
    if (!found) throw unauthorized();
    return c.json({ user: toUserView(found.user), csrfToken: found.session.csrf_token } satisfies Me);
  });

  return app;
}
