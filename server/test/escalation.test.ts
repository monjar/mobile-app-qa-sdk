/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TicketDetail } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { adminFetch, harness, jpeg, login, mp4, sendReport, type Harness, type Session } from './helpers';

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
