/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IntegrationView, TicketDetail, WebhookSecretCreated } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { syncComment } from '../src/integrations/githubSync';
import { RateLimiter } from '../src/http/rateLimit';
import { adminFetch, FakeGithub, harness, jpeg, login, mp4, sendReport, type Harness, type Session } from './helpers';

async function addIntegration(h: Harness, s: Session, body: unknown): Promise<string> {
  const r = await adminFetch(h, s, `/projects/${h.projectId}/integrations`, { method: 'POST', body });
  expect(r.status).toBe(201);
  return (await r.json() as any).id;
}

const github = { kind: 'github', name: 'GitHub', config: { owner: 'monjar', repo: 'mochiro', labels: ['from-snitch'] }, secret: 'ghp_test' };

describe('routing and escalation', () => {
  it('auto-escalates bugs to GitHub exactly once despite a transient failure', async () => {
    const h = await harness();
    const s = await login(h);
    const gh = await addIntegration(h, s, github);
    await adminFetch(h, s, `/projects/${h.projectId}/routing`, { method: 'PUT', body: { rules: [{ reportType: 'bug', integrationId: gh, mode: 'auto' }] } });
    let creates = 0;
    h.onFetch((url, init) => {
      if (url.includes('/search/issues')) return Response.json({ items: [] });
      if (url.endsWith('/repos/monjar/mochiro/issues') && init.method === 'POST') {
        creates++;
        if (creates === 1) return new Response('upstream sad', { status: 502 });
        const body = JSON.parse(String(init.body));
        expect(body.title).toBe('[Bug] MOCH-1: Petting the face froze it for a second.');
        expect(body.labels).toEqual(['from-snitch', 'type:bug']);
        expect(body.body).toContain('<!-- snitch:ticket=');
        expect(body.body).toContain('iPhone16,2');
        expect(body.body).not.toContain('/s/'); // no public links unless opted in
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_test');
        return Response.json({ number: 77, html_url: 'https://github.com/monjar/mochiro/issues/77' }, { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const id = await sendReport(h);
    await drain(h.deps); // route → escalate (fails, retries later)
    expect(h.deps.integrations.escalationViews(id)[0]).toMatchObject({ state: 'queued', lastError: expect.stringContaining('502') });
    h.clock.t += 60_000;
    await drain(h.deps);
    h.clock.t += 60_000;
    await drain(h.deps);
    expect(creates).toBe(2);
    const detail = (await (await adminFetch(h, s, `/tickets/${id}`)).json() as any) as TicketDetail;
    expect(detail.escalations[0]).toMatchObject({ state: 'sent', externalUrl: 'https://github.com/monjar/mochiro/issues/77' });
    expect(detail.ticket.escalations[0]).toMatchObject({ kind: 'github', state: 'sent' });
    expect(detail.events.map((e) => e.kind)).toEqual(['created', 'completed', 'escalation_queued', 'escalated']);
    // Manual re-escalation to the same integration is refused.
    expect((await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId: gh } })).status).toBe(409);
  });

  it('a bad token fails permanently, shows in jobs and can be retried', async () => {
    const h = await harness();
    const s = await login(h);
    const gh = await addIntegration(h, s, github);
    let ok = false;
    h.onFetch((url) => {
      if (url.includes('/search/issues')) return Response.json({ items: [] });
      return ok ? Response.json({ number: 1, html_url: 'https://github.com/x/y/issues/1' }, { status: 201 }) : new Response('Bad credentials', { status: 401 });
    });
    const id = await sendReport(h);
    expect((await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId: gh } })).status).toBe(202);
    await drain(h.deps);
    const failed = (await (await adminFetch(h, s, `/tickets/${id}`)).json() as any) as TicketDetail;
    expect(failed.escalations[0]!.state).toBe('failed');
    expect(failed.events.at(-1)!.kind).toBe('escalation_failed');
    const dead = await (await adminFetch(h, s, '/jobs?state=dead')).json() as any;
    expect(dead).toHaveLength(1);
    ok = true;
    await adminFetch(h, s, `/jobs/${dead[0].id}/retry`, { method: 'POST' });
    await drain(h.deps);
    const after = (await (await adminFetch(h, s, `/tickets/${id}`)).json() as any) as TicketDetail;
    expect(after.escalations[0]!.state).toBe('sent');
  });

  it('finds an issue a previous attempt already created', async () => {
    const h = await harness();
    const s = await login(h);
    const gh = await addIntegration(h, s, github);
    const id = await sendReport(h);
    let posts = 0;
    h.onFetch((url, init) => {
      if (url.includes('/search/issues')) return Response.json({ items: [{ number: 9, html_url: 'https://github.com/monjar/mochiro/issues/9', body: `x <!-- snitch:ticket=${id} -->` }] });
      if (init.method === 'POST') posts++;
      return new Response('nope', { status: 500 });
    });
    await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId: gh } });
    await drain(h.deps);
    expect(posts).toBe(0);
    expect(h.deps.integrations.escalationViews(id)[0]!.externalUrl).toBe('https://github.com/monjar/mochiro/issues/9');
  });

  it('includes public share links only when the integration opts in', async () => {
    const h = await harness();
    const s = await login(h);
    const gh = await addIntegration(h, s, { ...github, config: { ...github.config, includeShareLinks: true, shareTtlDays: 7 } });
    let body = '';
    h.onFetch((url, init) => {
      if (url.includes('/search/issues')) return Response.json({ items: [] });
      body = JSON.parse(String(init.body)).body;
      return Response.json({ number: 3, html_url: 'https://github.com/a/b/issues/3' }, { status: 201 });
    });
    const id = await sendReport(h, { screenshot: jpeg(), video: mp4() });
    await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId: gh } });
    await drain(h.deps);
    const img = /<img src="http:\/\/snitch\.test(\/s\/[^"]+)"/.exec(body);
    expect(img).not.toBeNull();
    expect((await h.app.request(img![1]!)).status).toBe(200);
    expect(body).toMatch(/\[Screen recording \(15 s\)\]\(http:\/\/snitch\.test\/s\//);
  });

  it('emails with the screenshot inline', async () => {
    const h = await harness();
    const s = await login(h);
    const em = await addIntegration(h, s, { kind: 'email', name: 'Team mail', config: { to: ['qa@example.com'] } });
    await adminFetch(h, s, `/projects/${h.projectId}/routing`, { method: 'PUT', body: { rules: [{ reportType: '*', integrationId: em, mode: 'auto' }] } });
    const shot = jpeg();
    await sendReport(h, { screenshot: shot });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(1);
    const msg = h.mailer.sent[0]!;
    expect(msg.to).toEqual(['qa@example.com']);
    expect(msg.subject).toBe('[Snitch] MOCH-1 Bug: Petting the face froze it for a second.');
    expect(msg.html).toContain('cid:screenshot-');
    expect(msg.attachments![0]!.content.equals(shot)).toBe(true);
    expect(msg.text).toContain('http://snitch.test/tickets/');
  });

  it('suggest rules surface in the ticket without sending', async () => {
    const h = await harness();
    const s = await login(h);
    const em = await addIntegration(h, s, { kind: 'email', name: 'Ideas inbox', config: { to: ['pm@example.com'] } });
    await adminFetch(h, s, `/projects/${h.projectId}/routing`, { method: 'PUT', body: { rules: [{ reportType: 'idea', integrationId: em, mode: 'suggest' }] } });
    const id = await sendReport(h, {}, { type: 'idea' });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(0);
    const d = (await (await adminFetch(h, s, `/tickets/${id}`)).json() as any) as TicketDetail;
    expect(d.suggestedIntegrationIds).toEqual([em]);
    expect(d.events.map((e) => e.kind)).toContain('escalation_suggested');
  });

  it('signs generic webhooks and refuses private targets', async () => {
    const h = await harness();
    const s = await login(h);
    const hook = await addIntegration(h, s, { kind: 'webhook', name: 'Hook', config: { url: 'https://hooks.example.com/snitch' }, secret: 'shh' });
    const internal = await addIntegration(h, s, { kind: 'webhook', name: 'Internal', config: { url: 'http://metadata.internal/latest' } });
    let captured: { body: string; headers: Record<string, string> } | null = null;
    h.onFetch((_url, init) => {
      captured = { body: String(init.body), headers: init.headers as Record<string, string> };
      return new Response('ok');
    });
    const id = await sendReport(h);
    await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId: hook } });
    await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId: internal } });
    await drain(h.deps);
    expect(captured).not.toBeNull();
    const { body, headers } = captured!;
    const expected = 'sha256=' + createHmac('sha256', 'shh').update(`${headers['x-snitch-timestamp']}.${body}`).digest('hex');
    expect(headers['x-snitch-signature']).toBe(expected);
    expect(JSON.parse(body)).toMatchObject({ event: 'ticket.escalated', ticket: { key: 'MOCH-1', platform: 'ios' } });
    const views = h.deps.integrations.escalationViews(id);
    expect(views.find((v) => v.integrationName === 'Internal')).toMatchObject({ state: 'failed', lastError: expect.stringContaining('private address') });
    expect(h.fetchCalls).toHaveLength(1);
  });

  it('formats Slack messages', async () => {
    const h = await harness();
    const s = await login(h);
    const hook = await addIntegration(h, s, { kind: 'webhook', name: 'Slack', config: { url: 'https://hooks.slack.com/services/x', format: 'slack' } });
    let payload: { text: string; blocks: unknown[] } | null = null;
    h.onFetch((_u, init) => {
      payload = JSON.parse(String(init.body));
      return new Response('ok');
    });
    const id = await sendReport(h, {}, { description: 'Tap <here> & there' });
    await adminFetch(h, s, `/tickets/${id}/escalations`, { method: 'POST', body: { integrationId: hook } });
    await drain(h.deps);
    expect(payload!.text).toBe('MOCH-1 Bug: Tap &lt;here&gt; &amp; there');
    expect(payload!.blocks.length).toBeGreaterThan(2);
  });

  it('tests integrations from the dashboard', async () => {
    const h = await harness();
    const s = await login(h);
    const gh = await addIntegration(h, s, github);
    h.onFetch(() => Response.json({ full_name: 'monjar/mochiro', has_issues: true }));
    const ok = await adminFetch(h, s, `/integrations/${gh}/test`, { method: 'POST' });
    expect(await ok.json() as any).toEqual({ ok: true, message: 'Token can reach monjar/mochiro' });
    h.onFetch(() => new Response('Not Found', { status: 404 }));
    const bad = await adminFetch(h, s, `/integrations/${gh}/test`, { method: 'POST' });
    expect(bad.status).toBe(422);
    expect((await bad.json() as any).error.message).toContain('404');
  });

  it('never returns integration secrets', async () => {
    const h = await harness();
    const s = await login(h);
    await addIntegration(h, s, github);
    const list = await (await adminFetch(h, s, `/projects/${h.projectId}/integrations`)).text();
    expect(list).not.toContain('ghp_test');
    expect(JSON.parse(list)[0].hasSecret).toBe(true);
    const row = h.deps.db.prepare('SELECT secret_enc FROM integrations').get() as { secret_enc: string };
    expect(row.secret_enc).toMatch(/^v1\./);
    expect(row.secret_enc).not.toContain('ghp_test');
  });
});

describe('retention', () => {
  it('deletes tickets past retention with their blobs', async () => {
    const h = await harness({ config: { retentionDays: 30 } });
    const old = await sendReport(h);
    const key = h.deps.tickets.attachment(old, 'screenshot')!.storage_key!;
    h.clock.t += 31 * 86_400_000;
    const fresh = await sendReport(h);
    h.deps.jobs.enqueue('retention_sweep', {});
    await drain(h.deps);
    expect(h.deps.tickets.get(old)).toBeNull();
    expect(h.deps.tickets.get(fresh)).not.toBeNull();
    await expect(h.deps.blobs.readAll(key)).rejects.toThrow();
  });

  it('a project override of 0 keeps tickets forever', async () => {
    const h = await harness({ config: { retentionDays: 30 } });
    h.deps.projects.update(h.projectId, { retentionDays: null });
    h.deps.db.prepare('UPDATE projects SET retention_days = 0').run();
    const id = await sendReport(h);
    h.clock.t += 400 * 86_400_000;
    h.deps.jobs.enqueue('retention_sweep', {});
    await drain(h.deps);
    expect(h.deps.tickets.get(id)).not.toBeNull();
  });
});

// ── GitHub two-way sync ─────────────────────────────────────────────────────

const issueEvent = (action: string, number: number, stateReason: string | null = null, repo = 'mochiro') => ({
  action,
  issue: { number, html_url: `https://github.com/monjar/${repo}/issues/${number}`, state: action === 'closed' ? 'closed' : 'open', state_reason: stateReason },
  repository: { name: repo, owner: { login: 'monjar' } },
  sender: { login: 'octocat' },
});

const commentEvent = (number: number, id: number, body: string) => ({
  ...issueEvent('created', number),
  comment: { id, body, html_url: `https://github.com/monjar/mochiro/issues/${number}#issuecomment-${id}`, user: { login: 'octocat' } },
});

interface Synced {
  h: Harness;
  s: Session;
  gh: FakeGithub;
  integrationId: string;
  ticketId: string;
  secret: string;
  deliver: (event: string, payload: unknown, opts?: { secret?: string; signature?: string }) => Promise<Response>;
}

/** A ticket escalated to GitHub issue #1 through an integration with sync on and a webhook secret. */
async function synced(config: { syncStatus?: boolean; syncComments?: boolean } = { syncStatus: true, syncComments: true }): Promise<Synced> {
  const h = await harness();
  const s = await login(h);
  const gh = new FakeGithub();
  h.onFetch(gh.handle);
  const integrationId = await addIntegration(h, s, { ...github, config: { ...github.config, ...config } });
  const ticketId = await sendReport(h);
  await adminFetch(h, s, `/tickets/${ticketId}/escalations`, { method: 'POST', body: { integrationId } });
  await drain(h.deps);
  expect(gh.issues.get(1)).toBeDefined();
  const created = await adminFetch(h, s, `/integrations/${integrationId}/webhook-secret`, { method: 'POST' });
  expect(created.status).toBe(201);
  const { secret } = (await created.json()) as WebhookSecretCreated;
  const deliver: Synced['deliver'] = async (event, payload, opts = {}) => {
    const body = JSON.stringify(payload);
    const signature = opts.signature ?? 'sha256=' + createHmac('sha256', opts.secret ?? secret).update(body).digest('hex');
    return h.app.request(`/api/hooks/github/${integrationId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signature },
      body,
    });
  };
  return { h, s, gh, integrationId, ticketId, secret, deliver };
}

const status = (h: Harness, id: string) => h.deps.tickets.get(id)!.status;

describe('github webhook secret', () => {
  it('is admin-only, GitHub-only, shown once and audited', async () => {
    const h = await harness();
    const s = await login(h);
    const gh = await addIntegration(h, s, github);
    const mail = await addIntegration(h, s, { kind: 'email', name: 'Mail', config: { to: ['qa@example.com'] } });
    const before = ((await (await adminFetch(h, s, `/projects/${h.projectId}/integrations`)).json()) as IntegrationView[]);
    expect(before.find((i) => i.id === gh)!.webhook).toEqual({ url: `http://snitch.test/api/hooks/github/${gh}`, configured: false });
    expect(before.find((i) => i.id === mail)!.webhook).toBeNull();

    await h.deps.users.create({ email: 'm@example.com', password: 'member password 1', role: 'member' });
    const ms = await login(h, { email: 'm@example.com', password: 'member password 1' });
    expect((await adminFetch(h, ms, `/integrations/${gh}/webhook-secret`, { method: 'POST' })).status).toBe(403);
    expect((await adminFetch(h, s, `/integrations/${mail}/webhook-secret`, { method: 'POST' })).status).toBe(422);
    expect((await adminFetch(h, s, '/integrations/nope/webhook-secret', { method: 'POST' })).status).toBe(404);

    const created = (await (await adminFetch(h, s, `/integrations/${gh}/webhook-secret`, { method: 'POST' })).json()) as WebhookSecretCreated;
    expect(created.url).toBe(`http://snitch.test/api/hooks/github/${gh}`);
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    const after = ((await (await adminFetch(h, s, `/projects/${h.projectId}/integrations`)).text()));
    expect(after).not.toContain(created.secret);
    expect((JSON.parse(after) as IntegrationView[]).find((i) => i.id === gh)!.webhook!.configured).toBe(true);
    const row = h.deps.db.prepare('SELECT webhook_secret_enc FROM integrations WHERE id = ?').get(gh) as { webhook_secret_enc: string };
    expect(row.webhook_secret_enc).toMatch(/^v1\./);
    const audit = (await (await adminFetch(h, s, '/audit')).json()) as any[];
    expect(audit[0]).toMatchObject({ action: 'integration.webhook_secret_created', target: gh });
  });
});

describe('github webhooks', () => {
  it('refuses unsigned, wrongly signed and unknown deliveries, and answers pings', async () => {
    const { h, deliver, integrationId } = await synced();
    expect((await deliver('ping', { zen: 'hi' })).status).toBe(204);
    expect((await deliver('ping', { zen: 'hi' }, { secret: 'wrong' })).status).toBe(401);
    expect((await deliver('ping', { zen: 'hi' }, { signature: '' })).status).toBe(401);
    const unknown = await h.app.request('/api/hooks/github/nope', { method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
    expect(unknown.status).toBe(401);
    const big = await h.app.request(`/api/hooks/github/${integrationId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) }, body: 'x'.repeat(2 * 1024 * 1024) });
    expect(big.status).toBe(413);
  });

  it('rate limits per address', async () => {
    const { h, deliver } = await synced();
    h.deps.limiters.hooksPerIp = new RateLimiter(2, 60_000, () => h.clock.t);
    expect((await deliver('ping', {})).status).toBe(204);
    expect((await deliver('ping', {})).status).toBe(204);
    expect((await deliver('ping', {})).status).toBe(429);
  });

  it('closing and reopening the issue moves the ticket, without echoing back', async () => {
    const { h, s, gh, ticketId, integrationId, deliver } = await synced();
    const writes = gh.writes().length;
    const closed = await deliver('issues', issueEvent('closed', 1, 'completed'));
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ handled: true, detail: 'ticket is now resolved' });
    expect(status(h, ticketId)).toBe('resolved');
    const d = (await (await adminFetch(h, s, `/tickets/${ticketId}`)).json()) as TicketDetail;
    expect(d.events.slice(-2).map((e) => [e.kind, e.actor.type])).toEqual([
      ['external_status_changed', 'integration'],
      ['status_changed', 'integration'],
    ]);
    expect(d.events.at(-2)!.data).toEqual({ integrationId, state: 'closed', stateReason: 'completed', url: 'https://github.com/monjar/mochiro/issues/1', author: 'octocat' });
    // Redelivered, or closed again for another reason: already closed.
    expect(await (await deliver('issues', issueEvent('closed', 1, 'not_planned'))).json()).toEqual({ handled: false, detail: 'ticket is already closed' });
    expect(status(h, ticketId)).toBe('resolved');

    await deliver('issues', issueEvent('reopened', 1));
    expect(status(h, ticketId)).toBe('triaged');
    expect(await (await deliver('issues', issueEvent('reopened', 1))).json()).toMatchObject({ handled: false });
    await deliver('issues', issueEvent('closed', 1, 'not_planned'));
    expect(status(h, ticketId)).toBe('wont_fix');

    // None of that went back to GitHub.
    await drain(h.deps);
    expect(h.deps.jobs.list(null).map((j) => j.kind)).not.toContain('github_status');
    expect(gh.writes()).toHaveLength(writes);
  });

  it('ignores other repositories, unknown issues, other actions and switched-off sync', async () => {
    const { h, ticketId, deliver } = await synced({ syncStatus: false, syncComments: false });
    expect(await (await deliver('issues', issueEvent('closed', 1, null, 'other'))).json()).toMatchObject({ handled: false, detail: expect.stringContaining('is not monjar/mochiro') });
    expect(await (await deliver('issues', issueEvent('closed', 99))).json()).toMatchObject({ handled: false, detail: 'issue #99 is not linked to a ticket' });
    expect(await (await deliver('issues', issueEvent('labeled', 1))).json()).toMatchObject({ handled: false });
    expect(await (await deliver('issues', issueEvent('closed', 1))).json()).toEqual({ handled: false, detail: 'status sync is off' });
    expect(await (await deliver('issue_comment', commentEvent(1, 5, 'hi'))).json()).toEqual({ handled: false, detail: 'comment sync is off' });
    expect(await (await deliver('push', {})).json()).toMatchObject({ handled: false });
    expect(status(h, ticketId)).toBe('new');
  });

  it('imports issue comments once, and never Snitch’s own', async () => {
    const { h, s, ticketId, integrationId, deliver } = await synced();
    const r = await deliver('issue_comment', commentEvent(1, 501, 'Fixed on main, please retest'));
    expect(await r.json()).toEqual({ handled: true, detail: 'comment added' });
    expect(await (await deliver('issue_comment', commentEvent(1, 501, 'Fixed on main, please retest'))).json()).toEqual({ handled: false, detail: 'comment already recorded' });
    expect(await (await deliver('issue_comment', commentEvent(1, 502, `**Ada** commented in Snitch:\n\nhello\n\n<!-- snitch:comment:3 -->`))).json()).toEqual({
      handled: false,
      detail: 'comment came from Snitch',
    });
    const d = (await (await adminFetch(h, s, `/tickets/${ticketId}`)).json()) as TicketDetail;
    const external = d.events.filter((e) => e.kind === 'external_comment');
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      actor: { type: 'integration' },
      data: { integrationId, body: 'Fixed on main, please retest', author: 'octocat', url: 'https://github.com/monjar/mochiro/issues/1#issuecomment-501', externalId: '501' },
    });
    expect(h.deps.jobs.list(null).map((j) => j.kind)).not.toContain('github_comment');
  });
});

describe('github outbound sync', () => {
  it('closes and reopens the issue when the ticket is resolved, won’t-fixed or reopened', async () => {
    const { h, s, gh, ticketId } = await synced();
    const patch = (body: unknown) => adminFetch(h, s, `/tickets/${ticketId}`, { method: 'PATCH', body });
    await patch({ status: 'triaged' });
    expect(h.deps.jobs.list('queued').map((j) => j.kind)).not.toContain('github_status');
    await patch({ status: 'resolved' });
    await drain(h.deps);
    expect(gh.issues.get(1)).toMatchObject({ state: 'closed', stateReason: 'completed' });
    // Still closed, for another reason.
    await patch({ status: 'wont_fix' });
    await drain(h.deps);
    expect(gh.issues.get(1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    await patch({ status: 'in_progress' });
    await drain(h.deps);
    expect(gh.issues.get(1)!.state).toBe('open');
    await patch({ status: 'triaged' });
    await patch({ status: 'resolved' });
    await drain(h.deps);
    expect(gh.writes().filter((w) => w.method === 'PATCH').map((w) => w.body)).toEqual([
      { state: 'closed', state_reason: 'completed' },
      { state: 'closed', state_reason: 'not_planned' },
      { state: 'open' },
      { state: 'closed', state_reason: 'completed' },
    ]);
  });

  it('a marked duplicate closes the issue as not planned, and the echo is ignored', async () => {
    const { h, s, gh, ticketId, deliver } = await synced();
    const original = await sendReport(h);
    await adminFetch(h, s, `/tickets/${ticketId}`, { method: 'PATCH', body: { duplicateOfId: original } });
    await drain(h.deps);
    expect(gh.issues.get(1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    await deliver('issues', issueEvent('closed', 1, 'not_planned'));
    expect(status(h, ticketId)).toBe('duplicate');
  });

  it('retries a failed close, and converges on the latest status', async () => {
    const { h, s, gh, ticketId } = await synced();
    gh.failWrites = [502];
    await adminFetch(h, s, `/tickets/${ticketId}`, { method: 'PATCH', body: { status: 'resolved' } });
    await drain(h.deps);
    expect(gh.issues.get(1)!.state).toBe('open');
    // Reopened before the retry: both jobs now leave the issue open.
    await adminFetch(h, s, `/tickets/${ticketId}`, { method: 'PATCH', body: { status: 'triaged' } });
    h.clock.t += 60_000;
    await drain(h.deps);
    expect(gh.issues.get(1)!.state).toBe('open');
    expect(h.deps.jobs.list(null).filter((j) => j.kind === 'github_status').map((j) => j.state)).toEqual(['done', 'done']);
  });

  it('posts Snitch comments to the issue once, and not when sync is off', async () => {
    const { h, s, gh, ticketId, deliver } = await synced();
    await h.deps.users.update(h.deps.users.getByEmail('admin@example.com')!.id, { name: 'Ada' });
    const d = (await (await adminFetch(h, s, `/tickets/${ticketId}/comments`, { method: 'POST', body: { body: 'Repro on iPhone 15' } })).json()) as TicketDetail;
    const eventId = d.events.at(-1)!.id;
    await drain(h.deps);
    const comments = gh.issues.get(1)!.comments;
    expect(comments.map((c) => c.body)).toEqual([`**Ada** commented in Snitch:\n\nRepro on iPhone 15\n\n<!-- snitch:comment:${eventId} -->`]);
    // GitHub tells us about the comment we posted: not imported.
    expect(await (await deliver('issue_comment', commentEvent(1, comments[0]!.id, comments[0]!.body))).json()).toMatchObject({ handled: false });
    // A retry that finds its marker doesn't post again.
    const esc = h.deps.integrations.escalationViews(ticketId)[0]!;
    await syncComment(h.deps, esc.id, eventId, true);
    expect(gh.issues.get(1)!.comments).toHaveLength(1);

    const off = await synced({ syncStatus: false, syncComments: false });
    await adminFetch(off.h, off.s, `/tickets/${off.ticketId}/comments`, { method: 'POST', body: { body: 'quiet' } });
    await adminFetch(off.h, off.s, `/tickets/${off.ticketId}`, { method: 'PATCH', body: { status: 'resolved' } });
    expect(off.h.deps.jobs.list('queued')).toHaveLength(0);
  });
});
