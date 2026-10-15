/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { ApiTokenCreated, ApiTokenView, DeviceCodeInfo, DeviceCodeIssued, DeviceTokenResult, TicketDetail, TicketList, WhoAmI } from '@snitch/contract';
import { tokenScopeFor } from '../src/http/apiAuth';
import { normalizeUserCode } from '../src/repo/apiTokens';
import { RateLimiter } from '../src/http/rateLimit';
import { adminFetch, harness, jpeg, login, mp4, sendReport, type Harness, type Session } from './helpers';

const DAY = 86_400_000;

async function makeToken(h: Harness, s: Session, body: Record<string, unknown> = {}): Promise<ApiTokenCreated> {
  const r = await adminFetch(h, s, '/tokens', { method: 'POST', body: { name: 'laptop', scopes: ['tickets:read', 'tickets:write'], ...body } });
  expect(r.status).toBe(201);
  return (await r.json()) as ApiTokenCreated;
}

/** A request with only a bearer token: no cookie, no CSRF header. */
function bearer(h: Harness, token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return h.app.request(`/api/admin${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function member(h: Harness): Promise<Session> {
  await h.deps.users.create({ email: 'm@example.com', password: 'member password 1', role: 'member' });
  return login(h, { email: 'm@example.com', password: 'member password 1' });
}

describe('api tokens', () => {
  it('reads tickets and downloads attachments with a bearer token, no cookie or CSRF', async () => {
    const h = await harness();
    const s = await login(h);
    const ticketId = await sendReport(h, { screenshot: jpeg(3000), video: mp4() });
    const { token, view } = await makeToken(h, s, { scopes: ['tickets:read'] });
    expect(token).toMatch(/^snitch_at_[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(view).toMatchObject({ name: 'laptop', scopes: ['tickets:read'], viaDevice: false, prefix: `${token.slice(0, 14)}…`, lastUsedAt: null, revokedAt: null });
    expect(view.expiresAt).toBe(h.clock.t + 90 * DAY);

    const me = (await (await bearer(h, token, '/token')).json()) as WhoAmI;
    expect(me).toMatchObject({ user: { email: 'admin@example.com' }, token: { id: view.id, name: 'laptop', scopes: ['tickets:read'] }, server: { publicUrl: 'http://snitch.test' } });

    const list = (await (await bearer(h, token, '/tickets?status=all&q=MOCH-1')).json()) as TicketList;
    expect(list.items.map((t) => t.id)).toEqual([ticketId]);
    const detail = (await (await bearer(h, token, `/tickets/${ticketId}`)).json()) as TicketDetail;
    const shot = detail.attachments.find((a) => a.name === 'screenshot')!;
    const bytes = await bearer(h, token, shot.url.replace('/api/admin', ''));
    expect(bytes.status).toBe(200);
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(jpeg(3000));
    expect((await bearer(h, token, '/projects')).status).toBe(200);

    // Last use is recorded (and the token row never holds the token itself).
    const row = h.deps.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(view.id) as any;
    expect(row.last_used_at).toBe(h.clock.t);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('writes need tickets:write, are audited, and skip CSRF', async () => {
    const h = await harness();
    const s = await login(h);
    const ticketId = await sendReport(h);
    const read = (await makeToken(h, s, { name: 'read only', scopes: ['tickets:read'] })).token;
    const write = (await makeToken(h, s, { name: 'agent', scopes: ['tickets:read', 'tickets:write'] })).token;

    const denied = await bearer(h, read, `/tickets/${ticketId}`, { method: 'PATCH', body: { status: 'in_progress' } });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error.message).toContain('tickets:write');

    expect((await bearer(h, write, `/tickets/${ticketId}`, { method: 'PATCH', body: { status: 'in_progress' } })).status).toBe(200);
    expect((await bearer(h, write, `/tickets/${ticketId}/comments`, { method: 'POST', body: { body: 'Fix in PR #12' } })).status).toBe(201);
    expect(h.deps.tickets.get(ticketId)!.status).toBe('in_progress');

    // A write that fails changed nothing, so it isn't audited.
    expect((await bearer(h, write, `/tickets/${ticketId}`, { method: 'PATCH', body: { status: 'nope' } })).status).toBe(422);
    const audit = (await (await adminFetch(h, s, '/audit')).json()) as any[];
    expect(audit.filter((a) => a.action === 'api_token.write').map((a) => a.target)).toEqual([
      `POST /api/admin/tickets/${ticketId}/comments`,
      `PATCH /api/admin/tickets/${ticketId}`,
    ]);
    expect(audit[0].data).toMatchObject({ tokenName: 'agent' });
  });

  it('can’t reach anything outside its allowlist, however it is scoped', async () => {
    const h = await harness();
    const s = await login(h);
    const ticketId = await sendReport(h);
    const { token } = await makeToken(h, s);
    const refused: [string, string, unknown?][] = [
      ['GET', '/tokens'],
      ['POST', '/tokens', { name: 'more', scopes: ['tickets:read'] }],
      ['GET', '/users'],
      ['GET', '/audit'],
      ['GET', '/server'],
      ['POST', '/projects', { name: 'X', slug: 'x', ticketPrefix: 'X' }],
      ['GET', `/projects/${h.projectId}/integrations`],
      ['GET', `/projects/${h.projectId}/keys`],
      ['POST', '/tickets/bulk', { ids: [ticketId], action: 'status', status: 'resolved' }],
      ['DELETE', `/tickets/${ticketId}`],
      ['POST', `/tickets/${ticketId}/escalations`, { integrationId: 'x' }],
      ['GET', '/device/BCDF-GHJK'],
      ['POST', '/device/BCDF-GHJK/approve'],
    ];
    for (const [method, path, body] of refused) {
      const r = await bearer(h, token, path, { method, ...(body !== undefined ? { body } : {}) });
      expect([method, path, r.status]).toEqual([method, path, 403]);
    }
    expect(tokenScopeFor('GET', '/api/admin/tickets/bulk')).toBeUndefined();
    expect(tokenScopeFor('GET', '/api/admin/tickets/export')).toBeUndefined();
    expect(tokenScopeFor('HEAD', `/api/admin/attachments/${ticketId}/content`)).toBe('tickets:read');
  });

  it('refuses malformed, unknown, revoked and expired tokens, and disabled users', async () => {
    const h = await harness();
    const s = await login(h);
    const { token, view } = await makeToken(h, s, { expiresInDays: 1 });
    expect((await h.app.request('/api/admin/tickets', { headers: { authorization: 'Basic abc' } })).status).toBe(401);
    // A proxy's Basic auth in front of the dashboard is not a token: the session still decides.
    expect((await h.app.request('/api/admin/tickets', { headers: { cookie: s.cookie, authorization: 'Basic YWRtaW46eA==' } })).status).toBe(200);
    expect((await bearer(h, 'snitch_at_' + '0'.repeat(32), '/tickets')).status).toBe(401);
    expect((await bearer(h, 'not-a-token', '/tickets')).status).toBe(401);
    // A bearer header wins over a cookie: a bad token isn't rescued by a session.
    expect((await h.app.request('/api/admin/tickets', { headers: { cookie: s.cookie, authorization: 'Bearer nope' } })).status).toBe(401);

    expect((await bearer(h, token, '/tickets')).status).toBe(200);
    h.clock.t += DAY + 1;
    expect((await bearer(h, token, '/tickets')).status).toBe(401);

    const forever = await makeToken(h, s, { expiresInDays: null });
    expect(forever.view.expiresAt).toBeNull();
    h.clock.t += 1000 * DAY;
    const s2 = await login(h);
    expect((await bearer(h, forever.token, '/tickets')).status).toBe(200);
    expect((await adminFetch(h, s2, `/tokens/${forever.view.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await bearer(h, forever.token, '/tickets')).status).toBe(401);
    const mine = (await (await adminFetch(h, s2, '/tokens')).json()) as ApiTokenView[];
    expect(mine.map((t) => [t.id, t.revokedAt !== null])).toEqual([
      [forever.view.id, true],
      [view.id, false],
    ]);

    // A password reset signs out every client, tokens included.
    const ms0 = await member(h);
    const before = await makeToken(h, ms0);
    const m0 = h.deps.users.getByEmail('m@example.com')!;
    expect((await adminFetch(h, s2, `/users/${m0.id}`, { method: 'PATCH', body: { password: 'a brand new password' } })).status).toBe(200);
    expect((await bearer(h, before.token, '/tickets')).status).toBe(401);
    const ms = await login(h, { email: 'm@example.com', password: 'a brand new password' });

    // Disabling the user revokes their tokens for good.
    const theirs = await makeToken(h, ms);
    const memberRow = h.deps.users.getByEmail('m@example.com')!;
    await adminFetch(h, s2, `/users/${memberRow.id}`, { method: 'PATCH', body: { disabled: true } });
    expect((await bearer(h, theirs.token, '/tickets')).status).toBe(401);
    await adminFetch(h, s2, `/users/${memberRow.id}`, { method: 'PATCH', body: { disabled: false } });
    expect((await bearer(h, theirs.token, '/tickets')).status).toBe(401);
  });

  it('a token can revoke itself; members see and revoke only their own; admins see all', async () => {
    const h = await harness();
    const s = await login(h);
    const ms = await member(h);
    const adminToken = await makeToken(h, s, { name: 'admin laptop' });
    const memberToken = await makeToken(h, ms, { name: 'member laptop' });

    expect(((await (await adminFetch(h, ms, '/tokens')).json()) as ApiTokenView[]).map((t) => t.name)).toEqual(['member laptop']);
    expect((await adminFetch(h, ms, '/tokens?all=true')).status).toBe(403);
    expect((await adminFetch(h, ms, `/tokens/${adminToken.view.id}`, { method: 'DELETE' })).status).toBe(404);
    const all = (await (await adminFetch(h, s, '/tokens?all=true')).json()) as ApiTokenView[];
    expect(all.map((t) => [t.name, t.user?.email])).toEqual([
      ['member laptop', 'm@example.com'],
      ['admin laptop', 'admin@example.com'],
    ]);

    expect((await bearer(h, memberToken.token, '/token', { method: 'DELETE' })).status).toBe(200);
    expect((await bearer(h, memberToken.token, '/token')).status).toBe(401);
    expect((await adminFetch(h, s, '/token', { method: 'DELETE' })).status).toBe(422);
  });

  it('validates what it creates', async () => {
    const h = await harness();
    const s = await login(h);
    for (const body of [{ name: '', scopes: ['tickets:read'] }, { name: 'x', scopes: [] }, { name: 'x', scopes: ['admin'] }, { name: 'x', scopes: ['tickets:read'], expiresInDays: 400 }]) {
      expect((await adminFetch(h, s, '/tokens', { method: 'POST', body })).status).toBe(422);
    }
    const dup = await makeToken(h, s, { scopes: ['tickets:read', 'tickets:read'] });
    expect(dup.view.scopes).toEqual(['tickets:read']);
  });

  it('rate limits per token', async () => {
    const h = await harness();
    const s = await login(h);
    const { token } = await makeToken(h, s);
    h.deps.limiters.apiPerToken = new RateLimiter(2, 60_000, () => h.clock.t);
    expect((await bearer(h, token, '/tickets')).status).toBe(200);
    expect((await bearer(h, token, '/tickets')).status).toBe(200);
    expect((await bearer(h, token, '/tickets')).status).toBe(429);
  });
});

describe('device sign-in', () => {
  const start = async (h: Harness, body: Record<string, unknown> = { clientName: 'snitch CLI on test-mac' }) => {
    const r = await h.app.request('/api/admin/auth/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status).toBe(201);
    return (await r.json()) as DeviceCodeIssued;
  };
  const poll = async (h: Harness, deviceCode: string) => {
    const r = await h.app.request('/api/admin/auth/device/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode }) });
    expect(r.status).toBe(200);
    return (await r.json()) as DeviceTokenResult;
  };

  it('pending → approved in the dashboard → a token, handed out exactly once', async () => {
    const h = await harness();
    const s = await login(h);
    const d = await start(h);
    expect(d.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(d).toMatchObject({ verificationUrl: 'http://snitch.test/device', verificationUrlComplete: `http://snitch.test/device?code=${d.userCode}`, expiresIn: 600, interval: 5 });
    expect(await poll(h, d.deviceCode)).toEqual({ status: 'pending' });

    // The page finds the code however it's typed.
    const info = (await (await adminFetch(h, s, `/device/${d.userCode.replace('-', '').toLowerCase()}`)).json()) as DeviceCodeInfo;
    expect(info).toMatchObject({ userCode: d.userCode, clientName: 'snitch CLI on test-mac', scopes: ['tickets:read', 'tickets:write'], tokenDays: 90, state: 'pending' });
    // Both requests come from the same test address here.
    expect(info.fromYourAddress).toBe(info.ip !== null);
    const approved = await adminFetch(h, s, `/device/${d.userCode}/approve`, { method: 'POST' });
    expect(((await approved.json()) as DeviceCodeInfo).state).toBe('approved');
    expect((await adminFetch(h, s, `/device/${d.userCode}/deny`, { method: 'POST' })).status).toBe(422);

    h.clock.t += 5000;
    const got = await poll(h, d.deviceCode);
    if (got.status !== 'approved') throw new Error(`expected approved, got ${got.status}`);
    expect(got.user.email).toBe('admin@example.com');
    expect(got.view).toMatchObject({ name: 'snitch CLI on test-mac', viaDevice: true, scopes: ['tickets:read', 'tickets:write'] });
    expect((await bearer(h, got.token, '/tickets')).status).toBe(200);

    h.clock.t += 5000;
    expect(await poll(h, d.deviceCode)).toEqual({ status: 'expired' });
    expect((await adminFetch(h, s, `/device/${d.userCode}`)).status).toBe(404);
    const audit = ((await (await adminFetch(h, s, '/audit')).json()) as any[]).map((a) => a.action);
    expect(audit.slice(0, 2)).toEqual(['api_token.created', 'device.approved']);
  });

  it('denied, expired, too-fast polling and unknown codes', async () => {
    const h = await harness();
    const s = await login(h);
    const denied = await start(h);
    await adminFetch(h, s, `/device/${denied.userCode}/deny`, { method: 'POST' });
    expect(await poll(h, denied.deviceCode)).toEqual({ status: 'denied' });
    expect(await poll(h, denied.deviceCode)).toEqual({ status: 'expired' });

    const fast = await start(h);
    expect(await poll(h, fast.deviceCode)).toEqual({ status: 'pending' });
    h.clock.t += 1000;
    expect(await poll(h, fast.deviceCode)).toEqual({ status: 'slow_down' });
    h.clock.t += 9000; // the interval is now 10 s
    expect(await poll(h, fast.deviceCode)).toEqual({ status: 'pending' });

    const late = await start(h);
    h.clock.t += 601_000;
    expect((await adminFetch(h, s, `/device/${late.userCode}/approve`, { method: 'POST' })).status).toBe(404);
    expect(await poll(h, late.deviceCode)).toEqual({ status: 'expired' });
    expect(await poll(h, 'nonsense')).toEqual({ status: 'expired' });
  });

  it('asks for what it needs and nothing more, and needs a session to approve', async () => {
    const h = await harness();
    const d = await start(h, { clientName: 'ci', scopes: ['tickets:read'], expiresInDays: 7 });
    expect((await h.app.request(`/api/admin/device/${d.userCode}/approve`, { method: 'POST' })).status).toBe(401);
    const s = await login(h);
    await adminFetch(h, s, `/device/${d.userCode}/approve`, { method: 'POST' });
    const got = await poll(h, d.deviceCode);
    if (got.status !== 'approved') throw new Error(got.status);
    expect(got.view.scopes).toEqual(['tickets:read']);
    expect(got.view.expiresAt).toBe(h.clock.t + 7 * DAY);
    expect((await h.app.request('/api/admin/auth/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientName: '' }) })).status).toBe(422);
  });

  it('a member who was disabled after approving gets no token', async () => {
    const h = await harness();
    const s = await login(h);
    const ms = await member(h);
    const d = await start(h);
    await adminFetch(h, ms, `/device/${d.userCode}/approve`, { method: 'POST' });
    await adminFetch(h, s, `/users/${h.deps.users.getByEmail('m@example.com')!.id}`, { method: 'PATCH', body: { disabled: true } });
    expect(await poll(h, d.deviceCode)).toEqual({ status: 'denied' });
  });

  it('rate limits starting sign-ins per address', async () => {
    const h = await harness();
    h.deps.limiters.deviceCodesPerIp = new RateLimiter(1, 60_000, () => h.clock.t);
    await start(h);
    const r = await h.app.request('/api/admin/auth/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientName: 'x' }) });
    expect(r.status).toBe(429);
  });

  it('normalizes user codes', () => {
    expect(normalizeUserCode('bcdf ghjk')).toBe('BCDF-GHJK');
    expect(normalizeUserCode('BCDF-GHJK')).toBe('BCDF-GHJK');
  });
});
