/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { describe, expect, it } from 'vitest';
import type { ProjectView, TicketDetail } from '@snitch/contract';
import { drain } from '../src/worker/worker';
import { ConsoleMailer } from '../src/mail/mailer';
import { ADMIN, adminFetch, harness, login, sendReport, type Harness, type Session } from './helpers';

async function withMember(h: Harness): Promise<{ s: Session; memberId: string }> {
  const s = await login(h);
  await h.deps.users.update(h.deps.users.getByEmail(ADMIN.email)!.id, { name: 'Ada' });
  const member = await h.deps.users.create({ email: 'dev@example.com', password: 'member password 1', role: 'member' });
  return { s, memberId: member.id };
}

const events = async (h: Harness, s: Session, id: string) => ((await (await adminFetch(h, s, `/tickets/${id}`)).json()) as TicketDetail).events;

describe('assignment emails', () => {
  it('emails the new assignee a link to the ticket', async () => {
    const h = await harness();
    const { s, memberId } = await withMember(h);
    const id = await sendReport(h);
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { assigneeUserId: memberId } });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(1);
    const msg = h.mailer.sent[0]!;
    expect(msg.to).toEqual(['dev@example.com']);
    expect(msg.subject).toBe('[Snitch] MOCH-1 assigned to you: Petting the face froze it for a second.');
    expect(msg.text).toContain('Ada assigned MOCH-1 to you.');
    expect(msg.text).toContain(`http://snitch.test/tickets/${id}`);
    expect(msg.html).toContain(`href="http://snitch.test/tickets/${id}"`);
    expect((await events(h, s, id)).at(-1)).toMatchObject({ kind: 'notification_sent', actor: { type: 'system' }, data: { to: 'assignee', email: 'dev@example.com' } });
  });

  it('stays quiet for self-assignment, when switched off, and after a quick reassignment', async () => {
    const h = await harness();
    const { s, memberId } = await withMember(h);
    const id = await sendReport(h);
    const me = h.deps.users.getByEmail(ADMIN.email)!.id;
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { assigneeUserId: me } });
    expect(h.deps.jobs.list(null).filter((j) => j.kind === 'notify')).toHaveLength(0);

    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { assigneeUserId: memberId } });
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { assigneeUserId: null } });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(0);

    const p = (await (await adminFetch(h, s, `/projects/${h.projectId}`, { method: 'PATCH', body: { notifyAssignees: false } })).json()) as ProjectView;
    expect(p).toMatchObject({ notifyAssignees: false, notifyReporters: false });
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { assigneeUserId: memberId } });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(0);
  });

  it('records a failure once retries run out, or at once for a permanent SMTP error', async () => {
    const h = await harness();
    const { s, memberId } = await withMember(h);
    const id = await sendReport(h);
    h.mailer.failNext = 5;
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { assigneeUserId: memberId } });
    for (let i = 0; i < 6; i++) {
      await drain(h.deps);
      h.clock.t += 24 * 3600_000;
    }
    expect(h.mailer.sent).toHaveLength(0);
    expect(h.deps.jobs.list('dead').map((j) => [j.kind, j.attempts])).toEqual([['notify', 5]]);
    const s2 = await login(h);
    const failed = (await events(h, s2, id)).filter((e) => e.kind.startsWith('notification_'));
    expect(failed).toEqual([expect.objectContaining({ kind: 'notification_failed', data: { to: 'assignee', email: 'dev@example.com', error: 'SMTP send failed: smtp down' } })]);

    const other = await sendReport(h);
    h.mailer.send = async () => Promise.reject(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }));
    await adminFetch(h, s2, `/tickets/${other}`, { method: 'PATCH', body: { assigneeUserId: memberId } });
    await drain(h.deps);
    expect((await events(h, s2, other)).at(-1)).toMatchObject({ kind: 'notification_failed', data: { error: 'SMTP send failed: 550 mailbox unavailable' } });
  });

  it('only logs the message when SMTP is not configured', async () => {
    const h = await harness();
    const { s, memberId } = await withMember(h);
    const consoleMailer = new ConsoleMailer();
    h.deps.mailer = consoleMailer;
    const id = await sendReport(h);
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { assigneeUserId: memberId } });
    await drain(h.deps);
    expect(consoleMailer.sent.map((m) => m.subject)).toEqual(['[Snitch] MOCH-1 assigned to you: Petting the face froze it for a second.']);
    expect((await events(h, s, id)).map((e) => e.kind)).not.toContain('notification_sent');
  });
});

describe('resolved emails to reporters', () => {
  it('thanks the reporter with the build it is fixed in, and nothing internal', async () => {
    const h = await harness();
    const s = await login(h);
    await adminFetch(h, s, `/projects/${h.projectId}`, { method: 'PATCH', body: { notifyReporters: true } });
    const id = await sendReport(h);
    await adminFetch(h, s, `/tickets/${id}/comments`, { method: 'POST', body: { body: 'Internal: the cache was stale' } });
    const d = (await (await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { status: 'resolved', fixedIn: '0.6.1 (16)' } })).json()) as TicketDetail;
    expect(d.ticket.fixedIn).toBe('0.6.1 (16)');
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(1);
    const msg = h.mailer.sent[0]!;
    expect(msg.to).toEqual(['tester@example.com']);
    expect(msg.subject).toBe('[Mochiro] MOCH-1 resolved: Petting the face froze it for a second.');
    expect(msg.text).toContain('Thanks for your report.');
    expect(msg.text).toContain('Fixed in 0.6.1 (16).');
    for (const part of [msg.text, msg.html]) {
      expect(part).not.toContain('cache was stale');
      expect(part).not.toContain('snitch.test');
    }
    expect((await events(h, s, id)).at(-1)).toMatchObject({ kind: 'notification_sent', data: { to: 'reporter', email: 'tester@example.com' } });
    // Resolving again (after a reopen) sends again; other closed states don't.
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { status: 'wont_fix', fixedIn: null } });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('is off by default and needs a reporter address', async () => {
    const h = await harness();
    const s = await login(h);
    const id = await sendReport(h);
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { status: 'resolved' } });
    await adminFetch(h, s, `/projects/${h.projectId}`, { method: 'PATCH', body: { notifyReporters: true } });
    const anonymous = await sendReport(h, {}, { reporter: undefined });
    await adminFetch(h, s, `/tickets/${anonymous}`, { method: 'PATCH', body: { status: 'resolved' } });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(0);
    expect(h.deps.jobs.list(null).filter((j) => j.kind === 'notify')).toHaveLength(0);
  });

  it('is cancelled when the ticket is reopened before it goes out', async () => {
    const h = await harness();
    const s = await login(h);
    await adminFetch(h, s, `/projects/${h.projectId}`, { method: 'PATCH', body: { notifyReporters: true } });
    const id = await sendReport(h);
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { status: 'resolved' } });
    await adminFetch(h, s, `/tickets/${id}`, { method: 'PATCH', body: { status: 'triaged' } });
    await drain(h.deps);
    expect(h.mailer.sent).toHaveLength(0);
  });
});
