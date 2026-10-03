/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { TicketDetail, TicketList } from '@snitch/contract';
import { adminFetch, ADMIN, harness, jpeg, login, mp4, sendReport } from './helpers';

describe('auth', () => {
  it('logs in, exposes me, enforces CSRF and logs out', async () => {
    const h = await harness();
    const s = await login(h);
    const me = await adminFetch(h, s, '/auth/me');
    expect((await me.json() as any).user.email).toBe(ADMIN.email);

    const noCsrf = await h.app.request('/api/admin/tickets/x/comments', {
      method: 'POST',
      headers: { cookie: s.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hi' }),
    });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json() as any).error.code).toBe('csrf');

    const crossOrigin = await adminFetch(h, s, '/projects', { method: 'POST', body: { name: 'X', slug: 'x', ticketPrefix: 'X' }, headers: { origin: 'https://evil.example' } });
    expect(crossOrigin.status).toBe(403);

    expect((await adminFetch(h, s, '/auth/logout', { method: 'POST' })).status).toBe(200);
    expect((await adminFetch(h, s, '/tickets')).status).toBe(401);
  });

  it('rejects wrong passwords and locks out after repeated failures', async () => {
    const h = await harness();
    const bad = await h.app.request('/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...ADMIN, password: 'wrong' }) });
    expect(bad.status).toBe(401);
    for (let i = 0; i < 9; i++) {
      await h.app.request('/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...ADMIN, password: 'wrong' }) });
    }
    const locked = await h.app.request('/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) });
    expect(locked.status).toBe(429);
  });

  it('first-run setup needs the token and works once', async () => {
    const h = await harness({ withAdmin: false });
    h.deps.setupToken.value = 'setup-token';
    expect(await (await h.app.request('/api/admin/auth/setup')).json() as any).toEqual({ needed: true });
    const body = { email: 'first@example.com', password: 'long enough password' };
    const wrong = await h.app.request('/api/admin/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token: 'nope' }) });
    expect(wrong.status).toBe(403);
    const ok = await h.app.request('/api/admin/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token: 'setup-token' }) });
    expect(ok.status).toBe(201);
    expect(ok.headers.get('set-cookie')).toContain('snitch_session=');
    const again = await h.app.request('/api/admin/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token: 'setup-token' }) });
    expect(again.status).toBe(409);
  });

  it('disabled users lose their sessions', async () => {
    const h = await harness();
    const s = await login(h);
    await h.deps.users.create({ email: 'm@example.com', password: 'member password 1', role: 'member' });
    const ms = await login(h, { email: 'm@example.com', password: 'member password 1' });
    const member = h.deps.users.getByEmail('m@example.com')!;
    expect((await adminFetch(h, s, `/users/${member.id}`, { method: 'PATCH', body: { disabled: true } })).status).toBe(200);
    expect((await adminFetch(h, ms, '/tickets')).status).toBe(401);
  });

  it('keeps at least one admin', async () => {
    const h = await harness();
    const s = await login(h);
    const me = h.deps.users.getByEmail(ADMIN.email)!;
    const r = await adminFetch(h, s, `/users/${me.id}`, { method: 'PATCH', body: { role: 'member' } });
    expect(r.status).toBe(422);
  });
});

describe('tickets', () => {
  it('lists, filters, searches and pages', async () => {
    const h = await harness();
    const s = await login(h);
    for (let i = 0; i < 5; i++) {
      h.clock.t += 1000;
      await sendReport(h, {}, { description: `Problem number ${i}`, type: i % 2 ? 'idea' : 'bug' });
    }
    const all = (await (await adminFetch(h, s, '/tickets?limit=2')).json() as any) as TicketList;
    expect(all.items.map((t) => t.key)).toEqual(['MOCH-5', 'MOCH-4']);
    expect(all.counts.new).toBe(5);
    const page2 = (await (await adminFetch(h, s, `/tickets?limit=2&cursor=${all.nextCursor}`)).json() as any) as TicketList;
    expect(page2.items.map((t) => t.key)).toEqual(['MOCH-3', 'MOCH-2']);
    const ideas = (await (await adminFetch(h, s, '/tickets?type=idea')).json() as any) as TicketList;
    expect(ideas.items).toHaveLength(2);
    const search = (await (await adminFetch(h, s, '/tickets?q=number%203')).json() as any) as TicketList;
    expect(search.items.map((t) => t.key)).toEqual(['MOCH-4']);
    const byKey = (await (await adminFetch(h, s, '/tickets?q=moch-2')).json() as any) as TicketList;
    expect(byKey.items.map((t) => t.key)).toEqual(['MOCH-2']);
    const pct = (await (await adminFetch(h, s, '/tickets?q=%25')).json() as any) as TicketList;
    expect(pct.items).toHaveLength(0);
  });

  it('shows detail, changes status/assignee/type, comments and keeps a timeline', async () => {
    const h = await harness();
    const s = await login(h);
    const id = await sendReport(h);
    const me = h.deps.users.getByEmail(ADMIN.email)!;
    const detail = (await (await adminFetch(h, s, `/tickets/${id}`)).json() as any) as TicketDetail;
    expect(detail.ticket.key).toBe('MOCH-1');
    expect(detail.ticket.hasScreenshot).toBe(true);
    expect(detail.ticket.videoSeconds).toBe(15);
    expect(detail.attachments.map((a) => a.name)).toEqual(['screenshot', 'video']);
    expect(detail.ticket.device.model).toBe('iPhone16,2');

    const patched = (await (await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { status: 'triaged', assigneeUserId: me.id, type: 'idea' } })).json() as any) as TicketDetail;
    expect(patched.ticket.status).toBe('triaged');
    expect(patched.ticket.assignee?.email).toBe(ADMIN.email);
    expect(patched.ticket.type).toBe('idea');
    const bad = await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { type: 'nonsense' } });
    expect(bad.status).toBe(422);

    const commented = (await (await adminFetch(h, s, `/tickets/${id}/comments`, { method: 'POST', body: { body: 'Reproduced on iPhone 15' } })).json() as any) as TicketDetail;
    expect(commented.events.map((e) => e.kind)).toEqual(['created', 'completed', 'type_changed', 'assigned', 'status_changed', 'comment']);
    expect(commented.events.at(-1)!.actor.name).toBe(ADMIN.email);
  });

  it('streams attachments with Range support', async () => {
    const h = await harness();
    const s = await login(h);
    const video = mp4(10_000);
    const id = await sendReport(h, { video });
    const att = h.deps.tickets.attachment(id, 'video')!;
    const full = await adminFetch(h, s, `/attachments/${att.id}/content`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer()).equals(video)).toBe(true);
    const part = await adminFetch(h, s, `/attachments/${att.id}/content`, { headers: { range: 'bytes=0-1' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-1/${video.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(video.subarray(0, 2));
    const tail = await adminFetch(h, s, `/attachments/${att.id}/content`, { headers: { range: 'bytes=-10' } });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(video.subarray(video.length - 10));
    const bad = await adminFetch(h, s, `/attachments/${att.id}/content`, { headers: { range: `bytes=${video.length}-` } });
    expect(bad.status).toBe(416);
    const head = await h.app.request(`/api/admin/attachments/${att.id}/content`, { method: 'HEAD', headers: { cookie: s.cookie } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(video.length));
    // Unauthenticated access is refused.
    expect((await h.app.request(`/api/admin/attachments/${att.id}/content`)).status).toBe(401);
  });

  it('share links work until revoked or expired', async () => {
    const h = await harness();
    const s = await login(h);
    const shot = jpeg();
    const id = await sendReport(h, { screenshot: shot });
    const att = h.deps.tickets.attachment(id, 'screenshot')!;
    const link = await (await adminFetch(h, s, `/attachments/${att.id}/share-links`, { method: 'POST', body: { expiresInDays: 1 } })).json() as any;
    const path = new URL(link.url).pathname;
    const pub = await h.app.request(path);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('x-robots-tag')).toContain('noindex');
    expect(Buffer.from(await pub.arrayBuffer()).equals(shot)).toBe(true);
    h.clock.t += 2 * 86_400_000;
    expect((await h.app.request(path)).status).toBe(404);

    const link2 = await (await adminFetch(h, s, `/attachments/${att.id}/share-links`, { method: 'POST', body: {} })).json() as any;
    const path2 = new URL(link2.url).pathname;
    expect((await h.app.request(path2)).status).toBe(200);
    await adminFetch(h, s, `/share-links/${link2.id}`, { method: 'DELETE' });
    expect((await h.app.request(path2)).status).toBe(404);
  });

  it('only admins delete tickets, and deletion removes blobs', async () => {
    const h = await harness();
    const s = await login(h);
    await h.deps.users.create({ email: 'm@example.com', password: 'member password 1', role: 'member' });
    const ms = await login(h, { email: 'm@example.com', password: 'member password 1' });
    const id = await sendReport(h);
    expect((await adminFetch(h, ms, `/tickets/${id}`, { method: 'DELETE' })).status).toBe(403);
    const key = h.deps.tickets.attachment(id, 'screenshot')!.storage_key!;
    expect((await adminFetch(h, s, `/tickets/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(h.deps.tickets.get(id)).toBeNull();
    await expect(h.deps.blobs.readAll(key)).rejects.toThrow();
  });
});

describe('projects', () => {
  it('creates projects with a key, edits settings and revokes keys', async () => {
    const h = await harness();
    const s = await login(h);
    const created = await (await adminFetch(h, s, '/projects', { method: 'POST', body: { name: 'Game', slug: 'game', ticketPrefix: 'GAME' } })).json() as any;
    expect(created.key.plaintext).toMatch(/^snitch_pk_[0-9A-HJKMNP-TV-Z]{26}$/);
    const dup = await adminFetch(h, s, '/projects', { method: 'POST', body: { name: 'Game', slug: 'game', ticketPrefix: 'GAME' } });
    expect(dup.status).toBe(409);
    const pid = created.project.id;
    const upd = await (await adminFetch(h, s, `/projects/${pid}`, { method: 'PATCH', body: { allowedReleaseTypes: ['debug'], reportTypes: [{ id: 'bug', label: 'Bug' }, { id: 'crash', label: 'Crash' }] } })).json() as any;
    expect(upd.allowedReleaseTypes).toEqual(['debug']);
    const cfg = await (await adminFetch(h, s, `/projects/${pid}/sdk-config`, { method: 'PUT', body: { entries: [{ platform: 'android', releaseType: '*', config: { video: { captureMode: 'off' } } }] } })).json() as any;
    expect(cfg.effective['android/debug'].video.captureMode).toBe('off');
    expect(cfg.effective['ios/debug'].video.captureMode).toBe('snapshot');
    expect(cfg.effective['ios/testflight'].enabled).toBe(false);
    expect(cfg.effective['ios/debug'].reportTypes.map((r: { id: string }) => r.id)).toEqual(['bug', 'crash']);
    expect((await adminFetch(h, s, `/keys/${created.key.key.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(h.deps.projects.authenticate(created.key.plaintext)).toBeNull();
    const audit = await (await adminFetch(h, s, '/audit')).json() as any;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['project.created', 'project.updated', 'sdk_config.updated', 'key.revoked']));
  });
});
