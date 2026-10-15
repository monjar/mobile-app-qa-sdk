/**
 * Login (password, or GitHub in githubLogin.ts), logout, current user, first-run
 * setup, and the set-password links behind invites and "Forgot password?".
 *
 * First run: with no users and no SNITCH_BOOTSTRAP_ADMIN_* env, the server
 * logs a one-time setup URL; whoever opens it creates the first admin. The
 * token keeps a freshly exposed server from being claimed by a stranger.
 *
 * "Forgot password?" answers the same way whether or not the address has an
 * account, and sends the email in the background, so neither the response nor
 * its timing tells a stranger who has one.
 */
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  LoginRequest,
  PASSWORD_MIN_LENGTH,
  PasswordResetRequest,
  SetPasswordRequest,
  type AccountTokenInfo,
  type AuthProviders,
  type Me,
} from '@snitch/contract';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { HttpError, notFound, unauthorized } from '../../http/errors';
import { jsonBody } from '../../http/validate';
import { clearSessionCookie, cookieName, requireSession, setSessionCookie, startSession } from '../../http/session';
import { DUMMY_HASH, verifyPassword } from '../../crypto/passwords';
import { safeEqual } from '../../crypto/tokens';
import { toUserView } from '../../repo/users';
import { LINK_TTL, sendAccountLink } from '../../mail/account';
import { githubLoginRoutes } from './githubLogin';

const SetupRequest = z.object({
  token: z.string().min(1).max(200),
  email: z.email().max(254),
  name: z.string().max(120).optional(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(512),
});

export function authRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/providers', (c) =>
    c.json({ password: true, github: deps.config.githubAuth !== null, passwordReset: deps.mailer.driver === 'smtp' } satisfies AuthProviders),
  );
  app.route('/github', githubLoginRoutes(deps));

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
    // Always run scrypt so response time doesn't reveal which emails exist (or which are still invited).
    const ok = await verifyPassword(body.password, user?.password_hash || DUMMY_HASH);
    if (!user || !ok || user.disabled_at !== null) {
      deps.audit.add(user?.id ?? null, 'login.failed', email, {}, c.get('ip'));
      throw new HttpError(401, 'unauthorized', 'Email or password is incorrect');
    }
    deps.limiters.loginPerEmail.reset(email);
    return c.json(startSession(c, deps, user, 'login') satisfies Me);
  });

  app.post('/password-reset', async (c) => {
    deps.limiters.loginPerIp.enforce(c.get('ip'), 'Too many requests; try again later');
    const email = (await jsonBody(c, PasswordResetRequest)).email.trim().toLowerCase();
    const user = deps.users.getByEmail(email);
    deps.audit.add(user?.id ?? null, 'password.reset_requested', email, { known: !!user }, c.get('ip'));
    if (user && user.disabled_at === null && deps.mailer.driver === 'smtp' && deps.limiters.resetEmailsPerAddress.hit(email) === 0) {
      void sendAccountLink(deps, user, 'reset', LINK_TTL.selfReset, null);
    }
    return c.json({ ok: true });
  });

  app.get('/account-token', (c) => {
    deps.limiters.loginPerIp.enforce(c.get('ip'), 'Too many requests; try again later');
    const found = deps.accountTokens.lookup(c.req.query('token') ?? '');
    if (!found || found.user.disabled_at !== null) throw notFound('This link has expired or was already used');
    const { row, user } = found;
    return c.json({ purpose: row.purpose, email: user.email, name: user.name, expiresAt: row.expires_at } satisfies AccountTokenInfo);
  });

  app.post('/set-password', async (c) => {
    deps.limiters.loginPerIp.enforce(c.get('ip'), 'Too many requests; try again later');
    const body = await jsonBody(c, SetPasswordRequest);
    const found = deps.accountTokens.lookup(body.token);
    if (!found || found.user.disabled_at !== null || !deps.accountTokens.consume(body.token)) throw notFound('This link has expired or was already used');
    const { row, user } = found;
    const name = row.purpose === 'invite' && body.name?.trim() ? body.name.trim() : undefined;
    await deps.users.update(user.id, { password: body.password, ...(name ? { name } : {}) });
    // A new password signs every other browser out.
    deps.sessions.deleteForUser(user.id);
    deps.limiters.loginPerEmail.reset(user.email.toLowerCase());
    const fresh = deps.users.get(user.id)!;
    return c.json(startSession(c, deps, fresh, row.purpose === 'invite' ? 'invite.accepted' : 'password.reset') satisfies Me);
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
