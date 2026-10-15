/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { AccountLink, AccountTokenInfo, Me, UserCreated } from '@snitch/contract';
import { ConsoleMailer } from '../src/mail/mailer';
import { DAY_MS, HOUR_MS } from '../src/util/clock';
import { adminFetch, ADMIN, harness, login, type Harness } from './helpers';

const json = { 'content-type': 'application/json' };
const post = (h: Harness, path: string, body: unknown) => h.app.request(`/api/admin${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });
/** The token from the set-password link in an email's text. */
const tokenIn = (text: string) => decodeURIComponent(/\/set-password\?token=([^\s]+)/.exec(text)![1]!);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('invites', () => {
  it('invites by email; the link sets a password and signs in, once', async () => {
    const h = await harness();
    const s = await login(h);
    const res = await adminFetch(h, s, '/users', { method: 'POST', body: { email: 'new@example.com', name: 'Nia', role: 'member' } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as UserCreated;
    expect(created.user).toMatchObject({ email: 'new@example.com', pending: true });
    expect(created.invite).toMatchObject({ emailed: true, error: null });
    expect(created.invite!.expiresAt).toBe(h.clock.t + 7 * DAY_MS);

    const mail = h.mailer.sent.at(-1)!;
    expect(mail.to).toEqual(['new@example.com']);
    expect(mail.subject).toBe('admin@example.com invited you to Snitch');
    const token = tokenIn(mail.text);
    expect(created.invite!.url).toBe(`http://snitch.test/set-password?token=${encodeURIComponent(token)}`);

    // Invited users can't sign in, and the timing-safe path still says "incorrect".
    expect((await post(h, '/auth/login', { email: 'new@example.com', password: '' + 'x'.repeat(12) })).status).toBe(401);

    const info = (await (await h.app.request(`/api/admin/auth/account-token?token=${encodeURIComponent(token)}`)).json()) as AccountTokenInfo;
    expect(info).toEqual({ purpose: 'invite', email: 'new@example.com', name: 'Nia', expiresAt: created.invite!.expiresAt });

    const short = await post(h, '/auth/set-password', { token, password: 'short' });
    expect(short.status).toBe(422);
    const set = await post(h, '/auth/set-password', { token, password: 'a long new password', name: 'Nia Long' });
    expect(set.status).toBe(200);
    expect(set.headers.get('set-cookie')).toContain('snitch_session=');
    const me = (await set.json()) as Me;
    expect(me.user).toMatchObject({ email: 'new@example.com', name: 'Nia Long', pending: false });

    expect((await post(h, '/auth/set-password', { token, password: 'another long password' })).status).toBe(404);
    expect((await h.app.request(`/api/admin/auth/account-token?token=${encodeURIComponent(token)}`)).status).toBe(404);
    await login(h, { email: 'new@example.com', password: 'a long new password' });
    expect(h.deps.audit.list().map((a) => a.action)).toEqual(expect.arrayContaining(['user.invited', 'invite.accepted']));
  });

  it('resending replaces the old link; invites expire', async () => {
    const h = await harness();
    const s = await login(h);
    const { user } = (await (await adminFetch(h, s, '/users', { method: 'POST', body: { email: 'late@example.com', role: 'member' } })).json()) as UserCreated;
    const first = tokenIn(h.mailer.sent.at(-1)!.text);
    const again = (await (await adminFetch(h, s, `/users/${user.id}/invite`, { method: 'POST' })).json()) as AccountLink;
    expect(again.emailed).toBe(true);
    const second = tokenIn(h.mailer.sent.at(-1)!.text);
    expect(second).not.toBe(first);
    expect((await post(h, '/auth/set-password', { token: first, password: 'a long new password' })).status).toBe(404);

    h.clock.t += 7 * DAY_MS + 1;
    expect((await post(h, '/auth/set-password', { token: second, password: 'a long new password' })).status).toBe(404);

    // Someone with a password gets a reset link, not an invite.
    const admin = h.deps.users.getByEmail(ADMIN.email)!;
    await h.deps.users.create({ email: 'set@example.com', password: 'member password 1', role: 'member' });
    const member = h.deps.users.getByEmail('set@example.com')!;
    expect((await adminFetch(h, s, `/users/${member.id}/invite`, { method: 'POST' })).status).toBe(422);
    expect(admin).toBeTruthy();
  });

  it('without SMTP, hands the link to the admin instead', async () => {
    const h = await harness();
    (h.deps as { mailer: unknown }).mailer = new ConsoleMailer();
    const s = await login(h);
    const created = (await (await adminFetch(h, s, '/users', { method: 'POST', body: { email: 'nosmtp@example.com', role: 'admin' } })).json()) as UserCreated;
    expect(created.invite).toMatchObject({ emailed: false });
    expect(created.invite!.error).toMatch(/no SMTP/);
    const token = new URL(created.invite!.url).searchParams.get('token')!;
    expect((await post(h, '/auth/set-password', { token, password: 'a long new password' })).status).toBe(200);
    expect(await (await h.app.request('/api/admin/auth/providers')).json()).toMatchObject({ passwordReset: false });
  });

  it('a failed send still creates the user and returns the link', async () => {
    const h = await harness();
    const s = await login(h);
    h.mailer.failNext = 1;
    const created = (await (await adminFetch(h, s, '/users', { method: 'POST', body: { email: 'bounce@example.com', role: 'member' } })).json()) as UserCreated;
    expect(created.user.pending).toBe(true);
    expect(created.invite).toMatchObject({ emailed: false, error: "The email couldn't be sent: smtp down" });
  });

  it('setting a password up front still works', async () => {
    const h = await harness();
    const s = await login(h);
    const created = (await (await adminFetch(h, s, '/users', { method: 'POST', body: { email: 'pw@example.com', role: 'member', password: 'member password 1' } })).json()) as UserCreated;
    expect(created).toMatchObject({ user: { pending: false }, invite: null });
    expect(h.mailer.sent).toHaveLength(0);
    await login(h, { email: 'pw@example.com', password: 'member password 1' });
  });
});

describe('password reset', () => {
  it('emails a link for known addresses only, and answers the same either way', async () => {
    const h = await harness();
    const unknown = await post(h, '/auth/password-reset', { email: 'nobody@example.com' });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true });
    await settle();
    expect(h.mailer.sent).toHaveLength(0);

    const known = await post(h, '/auth/password-reset', { email: 'ADMIN@example.com' });
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ ok: true });
    await settle();
    const mail = h.mailer.sent.at(-1)!;
    expect(mail).toMatchObject({ to: [ADMIN.email], subject: 'Reset your Snitch password' });
    expect(mail.text).toContain('for 1 hour');
    const token = tokenIn(mail.text);
    expect(((await (await h.app.request(`/api/admin/auth/account-token?token=${encodeURIComponent(token)}`)).json()) as AccountTokenInfo).purpose).toBe('reset');

    // A reset signs every other browser out and leaves the name alone.
    const old = await login(h);
    const done = await post(h, '/auth/set-password', { token, password: 'my brand new password', name: 'Ignored' });
    expect(done.status).toBe(200);
    expect(((await done.json()) as Me).user.name).toBeNull();
    expect((await adminFetch(h, old, '/tickets')).status).toBe(401);
    expect((await post(h, '/auth/login', ADMIN)).status).toBe(401);
    await login(h, { email: ADMIN.email, password: 'my brand new password' });
  });

  it('expires after an hour; disabled users get nothing; three emails an hour per address', async () => {
    const h = await harness();
    await post(h, '/auth/password-reset', { email: ADMIN.email });
    await settle();
    const token = tokenIn(h.mailer.sent.at(-1)!.text);
    h.clock.t += HOUR_MS + 1;
    expect((await post(h, '/auth/set-password', { token, password: 'my brand new password' })).status).toBe(404);

    for (let i = 0; i < 4; i++) await post(h, '/auth/password-reset', { email: ADMIN.email });
    await settle();
    expect(h.mailer.sent).toHaveLength(1 + 3);

    await h.deps.users.create({ email: 'off@example.com', password: 'member password 1', role: 'member' });
    const off = h.deps.users.getByEmail('off@example.com')!;
    await h.deps.users.update(off.id, { disabled: true });
    await post(h, '/auth/password-reset', { email: 'off@example.com' });
    await settle();
    expect(h.mailer.sent).toHaveLength(4);
  });

  it('admins can email a reset link, which lasts a day', async () => {
    const h = await harness();
    const s = await login(h);
    await h.deps.users.create({ email: 'forgot@example.com', name: 'Fo', password: 'member password 1', role: 'member' });
    const member = h.deps.users.getByEmail('forgot@example.com')!;
    const link = (await (await adminFetch(h, s, `/users/${member.id}/reset-link`, { method: 'POST' })).json()) as AccountLink;
    expect(link).toMatchObject({ emailed: true, expiresAt: h.clock.t + DAY_MS });
    const mail = h.mailer.sent.at(-1)!;
    expect(mail.text).toContain('admin@example.com sent you a link');
    expect(mail.text).toContain('for 24 hours');

    const ms = await login(h, { email: 'forgot@example.com', password: 'member password 1' });
    expect((await adminFetch(h, ms, `/users/${member.id}/reset-link`, { method: 'POST' })).status).toBe(403);
    const { user: invited } = (await (await adminFetch(h, s, '/users', { method: 'POST', body: { email: 'inv@example.com', role: 'member' } })).json()) as UserCreated;
    expect((await adminFetch(h, s, `/users/${invited.id}/reset-link`, { method: 'POST' })).status).toBe(422);
  });

  it('rejects made-up tokens', async () => {
    const h = await harness();
    expect((await h.app.request('/api/admin/auth/account-token?token=nope')).status).toBe(404);
    expect((await h.app.request('/api/admin/auth/account-token')).status).toBe(404);
    expect((await post(h, '/auth/set-password', { token: 'nope', password: 'a long new password' })).status).toBe(404);
  });
});
