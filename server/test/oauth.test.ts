/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { AuthProviders } from '@snitch/contract';
import type { GithubAuthConfig } from '../src/config';
import { safeNext } from '../src/routes/admin/githubLogin';
import { RateLimiter } from '../src/http/rateLimit';
import { ADMIN, FakeGithub, harness, type FakeGithubIdentity, type Harness } from './helpers';

const OAUTH: GithubAuthConfig = {
  clientId: 'gh-client',
  clientSecret: 'gh-secret',
  allowedOrg: null,
  autoCreate: false,
  webUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
};

const octo = (patch: Partial<FakeGithubIdentity> = {}): FakeGithubIdentity => ({
  user: { id: 4242, login: 'octo', name: 'Octo Cat' },
  emails: [
    { email: 'octo@users.noreply.github.com', verified: true, primary: false },
    { email: ADMIN.email.toUpperCase(), verified: true, primary: true },
  ],
  orgs: {},
  ...patch,
});

async function setup(auth: Partial<GithubAuthConfig> = {}, opts: { cookieSecure?: boolean } = {}) {
  const h = await harness({ config: { githubAuth: { ...OAUTH, ...auth }, ...(opts.cookieSecure ? { cookieSecure: true } : {}) } });
  const gh = new FakeGithub();
  h.onFetch(gh.handle);
  return { h, gh };
}

const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;

/** The whole browser round trip: start → (GitHub) → callback. */
async function signIn(h: Harness, code: string, opts: { next?: string; state?: string; cookie?: string | null; query?: string } = {}) {
  const start = await h.app.request(`/api/admin/auth/github/start${opts.next !== undefined ? `?next=${encodeURIComponent(opts.next)}` : ''}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cookie = opts.cookie === undefined ? cookiePair(start.headers.getSetCookie()[0]!) : opts.cookie;
  const query = opts.query ?? `code=${code}&state=${opts.state ?? state}`;
  const res = await h.app.request(`/api/admin/auth/github/callback?${query}`, { headers: cookie ? { cookie } : {} });
  expect(res.status).toBe(302);
  const session = res.headers.getSetCookie().find((c) => c.includes('snitch_session='));
  return { res, location: res.headers.get('location'), session: session ? cookiePair(session) : null };
}

describe('sign in with GitHub', () => {
  it('advertises the providers', async () => {
    const plain = await harness();
    expect(await (await plain.app.request('/api/admin/auth/providers')).json()).toEqual({ password: true, github: false } satisfies AuthProviders);
    expect((await plain.app.request('/api/admin/auth/github/start')).status).toBe(404);
    const { h } = await setup();
    expect(await (await h.app.request('/api/admin/auth/providers')).json()).toEqual({ password: true, github: true });
  });

  it('sends the browser to GitHub with a state bound to a short-lived cookie', async () => {
    const { h } = await setup();
    const res = await h.app.request('/api/admin/auth/github/start?next=/tickets/abc');
    const url = new URL(res.headers.get('location')!);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'gh-client',
      redirect_uri: 'http://snitch.test/api/admin/auth/github/callback',
      scope: 'read:user user:email',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
    });
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/^snitch_oauth=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).not.toContain('Secure');

    const org = await setup({ allowedOrg: 'mochiro-team' }, { cookieSecure: true });
    const r2 = await org.h.app.request('/api/admin/auth/github/start');
    expect(new URL(r2.headers.get('location')!).searchParams.get('scope')).toBe('read:user user:email read:org');
    expect(r2.headers.getSetCookie()[0]).toMatch(/^__Host-snitch_oauth=.*; Path=\/;.*Secure/);
  });

  it('links an existing user by verified email, then recognizes the GitHub account', async () => {
    const { h, gh } = await setup();
    gh.signsInWith('c1', octo());
    const first = await signIn(h, 'c1', { next: '/tickets/abc?tab=events' });
    expect(first.location).toBe('/tickets/abc?tab=events');
    expect(first.session).toBeTruthy();
    // The state cookie is single-use.
    expect(first.res.headers.getSetCookie().some((c) => /^snitch_oauth=;/.test(c))).toBe(true);
    const me = await h.app.request('/api/admin/auth/me', { headers: { cookie: first.session! } });
    expect(((await me.json()) as any).user.email).toBe(ADMIN.email);
    expect(h.deps.users.getByEmail(ADMIN.email)).toMatchObject({ github_id: 4242, github_login: 'octo' });
    expect(h.deps.audit.list()[0]).toMatchObject({ action: 'login.github' });
    // The token went to GitHub's API only, as a bearer token.
    expect(gh.calls.filter((c) => c.path.startsWith('/user')).every((c) => c.auth === 'Bearer gho_c1')).toBe(true);
    expect(gh.calls[0]).toMatchObject({ method: 'POST', path: '/login/oauth/access_token', body: { client_id: 'gh-client', client_secret: 'gh-secret', code: 'c1' } });

    // Later the GitHub account has other addresses; the link still holds. And a bad `next` goes home.
    gh.signsInWith('c2', octo({ user: { id: 4242, login: 'octo-renamed', name: null }, emails: [{ email: 'new@example.org', verified: true, primary: true }] }));
    const second = await signIn(h, 'c2', { next: '//evil.example/steal' });
    expect(second.location).toBe('/');
    expect(second.session).toBeTruthy();
    expect(h.deps.users.getByEmail(ADMIN.email)!.github_login).toBe('octo-renamed');
  });

  it('refuses a broken round trip', async () => {
    const { h, gh } = await setup();
    gh.signsInWith('c1', octo());
    const outcome = async (o: Parameters<typeof signIn>[2], code = 'c1') => {
      const r = await signIn(h, code, o);
      expect(r.session).toBeNull();
      return r.location;
    };
    expect(await outcome({ state: 'forged' })).toBe('/login?error=github_state');
    expect(await outcome({ cookie: null })).toBe('/login?error=github_state');
    expect(await outcome({ query: 'error=access_denied&error_description=nope' })).toBe('/login?error=github_denied');
    expect(await outcome({}, 'not-a-code')).toBe('/login?error=github_error');
    h.onFetch(() => new Response('down', { status: 503 }));
    expect(await outcome({})).toBe('/login?error=github_error');
    expect(h.deps.users.getByEmail(ADMIN.email)!.github_id).toBeNull();
  });

  it('only matches verified addresses, and never takes over an account linked elsewhere', async () => {
    const { h, gh } = await setup();
    gh.signsInWith('unverified', octo({ emails: [{ email: ADMIN.email, verified: false, primary: true }] }));
    expect((await signIn(h, 'unverified')).location).toBe('/login?error=github_no_user');
    h.deps.users.linkGithub(h.deps.users.getByEmail(ADMIN.email)!.id, 1, 'someone-else');
    gh.signsInWith('other', octo());
    expect((await signIn(h, 'other')).location).toBe('/login?error=github_no_user');
    expect(h.deps.audit.list()[0]).toMatchObject({ action: 'login.github_failed', data: { code: 'github_no_user', githubLogin: 'octo' } });
  });

  it('requires an active membership of the configured organization', async () => {
    const { h, gh } = await setup({ allowedOrg: 'mochiro-team' });
    gh.signsInWith('outsider', octo());
    gh.signsInWith('pending', octo({ orgs: { 'mochiro-team': 'pending' } }));
    gh.signsInWith('member', octo({ orgs: { 'mochiro-team': 'active' } }));
    expect((await signIn(h, 'outsider')).location).toBe('/login?error=github_org');
    expect((await signIn(h, 'pending')).location).toBe('/login?error=github_org');
    const ok = await signIn(h, 'member');
    expect(ok.location).toBe('/');
    expect(ok.session).toBeTruthy();
  });

  it('creates unknown users only with auto-create and an organization vouching for them', async () => {
    const stranger = octo({ user: { id: 7, login: 'newbie', name: 'New Bie' }, emails: [{ email: 'newbie@example.com', verified: true, primary: true }], orgs: { 'mochiro-team': 'active' } });

    const noAuto = await setup({ allowedOrg: 'mochiro-team' });
    noAuto.gh.signsInWith('c', stranger);
    expect((await signIn(noAuto.h, 'c')).location).toBe('/login?error=github_no_user');

    const noOrg = await setup({ autoCreate: true });
    noOrg.gh.signsInWith('c', stranger);
    expect((await signIn(noOrg.h, 'c')).location).toBe('/login?error=github_no_user');
    expect(noOrg.h.deps.users.getByEmail('newbie@example.com')).toBeNull();

    const both = await setup({ autoCreate: true, allowedOrg: 'mochiro-team' });
    both.gh.signsInWith('c', stranger);
    const r = await signIn(both.h, 'c');
    expect(r.location).toBe('/');
    expect(both.h.deps.users.getByEmail('newbie@example.com')).toMatchObject({ role: 'member', name: 'New Bie', github_id: 7, github_login: 'newbie' });
    expect(both.h.deps.audit.list().map((a) => a.action).slice(0, 2)).toEqual(['login.github', 'user.created']);
    // Its random password is nobody's.
    const login = await both.h.app.request('/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'newbie@example.com', password: 'x'.repeat(12) }) });
    expect(login.status).toBe(401);
  });

  it('refuses disabled users', async () => {
    const { h, gh } = await setup();
    await h.deps.users.update(h.deps.users.getByEmail(ADMIN.email)!.id, { disabled: true });
    gh.signsInWith('c1', octo());
    const r = await signIn(h, 'c1');
    expect(r.location).toBe('/login?error=github_disabled');
    expect(r.session).toBeNull();
  });

  it('shares the per-address sign-in budget with password login', async () => {
    const { h, gh } = await setup();
    h.deps.limiters.loginPerIp = new RateLimiter(1, 15 * 60_000, () => h.clock.t);
    gh.signsInWith('c1', octo());
    expect((await signIn(h, 'c1')).session).toBeTruthy();
    expect((await signIn(h, 'c1')).location).toBe('/login?error=github_error');
  });

  it('only returns to same-origin paths', () => {
    expect(safeNext('/tickets/1?x=1#y')).toBe('/tickets/1?x=1#y');
    for (const bad of [undefined, '', 'tickets', 'https://evil.example', '//evil.example', '/\\evil.example', '/ok\nSet-Cookie: x', `/${'a'.repeat(1000)}`]) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});
