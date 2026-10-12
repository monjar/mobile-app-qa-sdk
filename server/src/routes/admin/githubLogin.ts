/**
 * Sign in with GitHub (an OAuth app: SNITCH_GITHUB_CLIENT_ID / _SECRET).
 *
 *   GET /api/admin/auth/github/start?next=/path   → GitHub's consent page
 *   GET /api/admin/auth/github/callback           → a session, then back to `next`
 *
 * GitHub proves who someone is; whether they get in is decided here. A user
 * already linked to that GitHub account gets in, and so does one whose email
 * is a verified address of it (the account is linked then). Anyone else is
 * refused, unless SNITCH_GITHUB_AUTO_CREATE is on and the configured
 * organization vouches for them, in which case they become a member. With an
 * organization configured, every sign-in needs an active membership.
 *
 * Failures land on /login?error=<code>. The access token is used for the few
 * calls below and dropped: never stored, never logged.
 */
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { GithubAuthConfig } from '../../config';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { notFound } from '../../http/errors';
import { startSession } from '../../http/session';
import { randomToken, safeEqual } from '../../crypto/tokens';
import type { UserRow } from '../../repo/users';
import { errorMessage, log } from '../../log';
import { VERSION } from '../../version';

export const GITHUB_LOGIN_ERRORS = ['github_denied', 'github_state', 'github_org', 'github_no_user', 'github_disabled', 'github_error'] as const;
export type GithubLoginError = (typeof GITHUB_LOGIN_ERRORS)[number];

/** How long the round trip through GitHub may take. */
const STATE_TTL_SECONDS = 10 * 60;

/** A same-origin path to return to: `/…` but not `//host` or `/\host` (browsers treat both as another origin). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 1000 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) return '/';
  return raw;
}

function stateCookie(deps: Deps): string {
  // Same rule as the session cookie: __Host- needs Secure, which plain-http localhost can't do.
  return deps.config.cookieSecure ? '__Host-snitch_oauth' : 'snitch_oauth';
}

const GithubUser = z.object({ id: z.number().int().positive(), login: z.string().min(1), name: z.string().nullish() });
const GithubEmails = z.array(z.object({ email: z.string(), verified: z.boolean(), primary: z.boolean().optional() }));
const TokenResponse = z.object({ access_token: z.string().min(1).optional(), error: z.string().optional() });

interface GithubIdentity {
  id: number;
  login: string;
  name: string | null;
  /** Verified addresses only, primary first. */
  emails: string[];
  /** Active member of SNITCH_GITHUB_ALLOWED_ORG; null when none is configured. */
  orgMember: boolean | null;
}

class GithubLoginFailure extends Error {}

async function fetchIdentity(deps: Deps, gh: GithubAuthConfig, code: string, redirectUri: string): Promise<GithubIdentity> {
  const ua = `snitch-server/${VERSION}`;
  const exchange = await deps.fetch(`${gh.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = TokenResponse.safeParse(await exchange.json().catch(() => null));
  // GitHub answers a bad or reused code with 200 and an `error` field.
  if (!exchange.ok || !token.success || !token.data.access_token) {
    throw new GithubLoginFailure(`code exchange failed: HTTP ${exchange.status} ${token.success ? (token.data.error ?? '') : ''}`.trim());
  }
  const headers = { authorization: `Bearer ${token.data.access_token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': ua };
  const get = (path: string) => deps.fetch(`${gh.apiUrl}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  const read = async <S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> => {
    const res = await get(path);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !parsed.success) throw new GithubLoginFailure(`GET ${path} failed: HTTP ${res.status}`);
    return parsed.data;
  };

  const user = await read('/user', GithubUser);
  const emails = (await read('/user/emails', GithubEmails)).filter((e) => e.verified).sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false));
  let orgMember: boolean | null = null;
  if (gh.allowedOrg) {
    // 404 (not a member) and 403 (the org restricts this OAuth app) both mean no.
    const res = await get(`/user/memberships/orgs/${encodeURIComponent(gh.allowedOrg)}`);
    const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
    orgMember = res.ok && body?.state === 'active';
  }
  return { id: user.id, login: user.login, name: user.name ?? null, emails: emails.map((e) => e.email), orgMember };
}

export function githubLoginRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const redirectUri = `${deps.config.publicUrl}/api/admin/auth/github/callback`;

  app.get('/start', (c) => {
    const gh = deps.config.githubAuth;
    if (!gh) throw notFound('Sign in with GitHub is not configured');
    const state = randomToken(24);
    const next = safeNext(c.req.query('next'));
    setCookie(c, stateCookie(deps), `${state}.${Buffer.from(next).toString('base64url')}`, {
      httpOnly: true,
      secure: deps.config.cookieSecure,
      // Lax: the callback is a top-level navigation from GitHub, which Lax cookies ride along on.
      sameSite: 'Lax',
      path: '/',
      maxAge: STATE_TTL_SECONDS,
    });
    const url = new URL(`${gh.webUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', gh.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', gh.allowedOrg ? 'read:user user:email read:org' : 'read:user user:email');
    url.searchParams.set('state', state);
    return c.redirect(url.toString(), 302);
  });

  app.get('/callback', async (c) => {
    const fail = (code: GithubLoginError, audit?: { user: UserRow | null; login: string }) => {
      if (audit) deps.audit.add(audit.user?.id ?? null, 'login.github_failed', audit.user?.email ?? audit.login, { code, githubLogin: audit.login }, c.get('ip'));
      return c.redirect(`/login?error=${code}`, 302);
    };
    const gh = deps.config.githubAuth;
    // The state cookie is single-use, whatever happens next.
    const cookie = getCookie(c, stateCookie(deps));
    deleteCookie(c, stateCookie(deps), { path: '/', secure: deps.config.cookieSecure });
    if (!gh) return fail('github_error');
    // Same per-IP budget as password sign-in.
    if (deps.limiters.loginPerIp.hit(c.get('ip')) > 0) return fail('github_error');

    const q = c.req.query();
    if (q.error) return fail(q.error === 'access_denied' ? 'github_denied' : 'github_error');
    const [state = '', encodedNext = ''] = (cookie ?? '').split('.');
    if (!state || !q.state || !safeEqual(q.state, state)) return fail('github_state');
    if (!q.code) return fail('github_error');
    const next = safeNext(Buffer.from(encodedNext, 'base64url').toString('utf8'));

    let id: GithubIdentity;
    try {
      id = await fetchIdentity(deps, gh, q.code, redirectUri);
    } catch (e) {
      log.warn('auth', 'GitHub sign-in failed', { error: errorMessage(e) });
      return fail('github_error');
    }
    if (id.orgMember === false) return fail('github_org', { user: deps.users.getByGithubId(id.id), login: id.login });

    let user = deps.users.getByGithubId(id.id);
    if (!user) {
      const byEmail = id.emails.map((e) => deps.users.getByEmail(e)).find((u): u is UserRow => u !== null) ?? null;
      // An account already linked to another GitHub identity is not taken over through a shared address.
      if (byEmail && byEmail.github_id !== null) return fail('github_no_user', { user: byEmail, login: id.login });
      user = byEmail;
    }
    if (!user) {
      const email = id.emails[0];
      if (!gh.autoCreate || !gh.allowedOrg || id.orgMember !== true || !email) return fail('github_no_user', { user: null, login: id.login });
      // A random password nobody knows: the account signs in through GitHub until an admin sets one.
      const created = await deps.users.create({ email, name: id.name ?? id.login, role: 'member', password: randomToken(32) });
      deps.audit.add(created.id, 'user.created', created.id, { email, role: 'member', via: 'github', githubLogin: id.login }, c.get('ip'));
      user = deps.users.get(created.id)!;
    }
    if (user.disabled_at !== null) return fail('github_disabled', { user, login: id.login });
    if (user.github_id !== id.id || user.github_login !== id.login) deps.users.linkGithub(user.id, id.id, id.login);
    startSession(c, deps, user, 'login.github');
    return c.redirect(next, 302);
  });

  return app;
}
