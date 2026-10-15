/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { TicketBulkResult, TicketDetail } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { adminFetch, harness, jpeg, login, sendReport, type Harness, type Session } from './helpers';

const bulk = async (h: Harness, s: Session, body: unknown) => adminFetch(h, s, '/tickets/bulk', { method: 'POST', body });
const detail = async (h: Harness, s: Session, id: string) => (await (await adminFetch(h, s, `/tickets/${id}`)).json()) as TicketDetail;

async function tickets(h: Harness, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await sendReport(h, { screenshot: jpeg() }, { description: `Report ${i}` }));
  return ids;
}

async function member(h: Harness, s: Session, email: string): Promise<{ id: string; session: Session }> {
  await h.deps.users.create({ email, password: 'member password 1', role: 'member' });
  return { id: h.deps.users.getByEmail(email)!.id, session: await login(h, { email, password: 'member password 1' }) };
}

describe('bulk ticket actions', () => {
  it('assigns many tickets with one digest email, and reports what it skipped', async () => {
    const h = await harness();
    const s = await login(h);
    const ids = await tickets(h, 5);
    const m = await member(h, s, 'dev@example.com');
    h.mailer.sent = [];

    const res = await bulk(h, s, { action: 'assign', ids: [...ids, ids[0], 'missing'], assigneeUserId: m.id });
    expect(res.status).toBe(200);
    const r = (await res.json()) as TicketBulkResult;
    expect(r.done).toEqual(ids);
    expect(r.skipped).toEqual([{ id: 'missing', reason: 'not found' }]);
    for (const id of ids) expect((await detail(h, s, id)).ticket.assignee?.id).toBe(m.id);

    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0]).toMatchObject({ to: ['dev@example.com'], subject: '[Snitch] 5 tickets assigned to you' });
    expect(h.mailer.sent[0]!.text).toContain('MOCH-1  Report 0');
    expect((await detail(h, s, ids[0]!)).events.map((e) => e.kind)).toContain('notification_sent');

    // Again: nothing to change.
    const again = (await (await bulk(h, s, { action: 'assign', ids, assigneeUserId: m.id })).json()) as TicketBulkResult;
    expect(again.done).toEqual([]);
    expect(again.skipped.map((x) => x.reason)).toEqual(Array(5).fill('already assigned'));
    // Newest first: the second call, then the first.
    expect(h.deps.audit.list().filter((a) => a.action === 'tickets.bulk_assign').map((a) => a.data)).toMatchObject([{ done: 0, skipped: 5 }, { done: 5, skipped: 1 }]);
  });

  it('a few tickets get an email each; unassigning sends none', async () => {
    const h = await harness();
    const s = await login(h);
    const ids = await tickets(h, 2);
    const m = await member(h, s, 'dev@example.com');
    h.mailer.sent = [];
    await bulk(h, s, { action: 'assign', ids, assigneeUserId: m.id });
    await drain(h.deps);
    expect(h.mailer.sent.map((x) => x.subject)).toEqual([expect.stringContaining('MOCH-1 assigned to you'), expect.stringContaining('MOCH-2 assigned to you')]);
    h.mailer.sent = [];
    const off = (await (await bulk(h, s, { action: 'assign', ids, assigneeUserId: null })).json()) as TicketBulkResult;
    expect(off.done).toHaveLength(2);
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(0);
    expect((await bulk(h, s, { action: 'assign', ids, assigneeUserId: 'nobody' })).status).toBe(422);
  });

  it('changes status and emails reporters who asked', async () => {
    const h = await harness();
    const s = await login(h);
    await adminFetch(h, s, `/projects/${h.projectId}`, { method: 'PATCH', body: { notifyReporters: true } });
    const ids = await tickets(h, 3);
    h.mailer.sent = [];
    const r = (await (await bulk(h, s, { action: 'status', ids, status: 'resolved' })).json()) as TicketBulkResult;
    expect(r.done).toEqual(ids);
    for (const id of ids) expect((await detail(h, s, id)).ticket.status).toBe('resolved');
    await drain(h.deps);
    // The iOS fixture carries a reporter email.
    expect(h.mailer.sent.length).toBe(3);
    expect((await bulk(h, s, { action: 'status', ids, status: 'nope' })).status).toBe(422);
  });

  it('escalates to one integration, skipping repeats and other projects', async () => {
    const h = await harness();
    const s = await login(h);
    const ids = await tickets(h, 3);
    const created = await adminFetch(h, s, `/projects/${h.projectId}/integrations`, { method: 'POST', body: { kind: 'email', name: 'QA inbox', config: { to: ['qa@example.com'] } } });
    const integrationId = ((await created.json()) as any).id as string;
    const other = h.deps.projects.create({ name: 'Other', slug: 'other', ticketPrefix: 'OTH' });
    const otherIntegration = h.deps.integrations.create(other.id, 'email', 'Other inbox', { to: ['x@example.com'], subjectPrefix: '[Snitch]' }, null);

    await adminFetch(h, s, `/tickets/${ids[0]}/escalations`, { method: 'POST', body: { integrationId } });
    const r = (await (await bulk(h, s, { action: 'escalate', ids, integrationId })).json()) as TicketBulkResult;
    expect(r.done).toEqual(ids.slice(1));
    expect(r.skipped).toEqual([{ id: ids[0], reason: 'already escalated to QA inbox' }]);
    await drain(h.deps);
    for (const id of ids) expect((await detail(h, s, id)).escalations[0]).toMatchObject({ state: 'sent' });

    const cross = (await (await bulk(h, s, { action: 'escalate', ids: [ids[0]], integrationId: otherIntegration.id })).json()) as TicketBulkResult;
    expect(cross.skipped).toEqual([{ id: ids[0], reason: 'Other inbox belongs to another project' }]);
    expect((await bulk(h, s, { action: 'escalate', ids, integrationId: 'nope' })).status).toBe(422);
  });

  it('only admins delete, and deletion takes the media with it', async () => {
    const h = await harness();
    const s = await login(h);
    const ids = await tickets(h, 3);
    const m = await member(h, s, 'dev@example.com');
    expect((await bulk(h, m.session, { action: 'delete', ids })).status).toBe(403);
    // Members can do the rest.
    expect((await bulk(h, m.session, { action: 'status', ids, status: 'triaged' })).status).toBe(200);

    const keys = ids.flatMap((id) => h.deps.tickets.attachments(id).map((a) => a.storage_key!));
    const r = (await (await bulk(h, s, { action: 'delete', ids })).json()) as TicketBulkResult;
    expect(r.done).toEqual(ids);
    for (const id of ids) expect((await adminFetch(h, s, `/tickets/${id}`)).status).toBe(404);
    for (const key of keys) await expect(h.deps.blobs.head(key)).resolves.toBeNull();
    expect((await bulk(h, s, { action: 'delete', ids: [] })).status).toBe(422);
  });
});
