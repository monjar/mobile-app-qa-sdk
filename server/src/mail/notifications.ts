/**
 * Emails to people rather than integrations: the member a ticket was assigned
 * to (project.notifyAssignees) and the tester who reported it once it's
 * resolved (project.notifyReporters). The `notify` job sends them, so SMTP
 * hiccups retry; a send, or a final failure, is an event on the ticket.
 *
 * Reporter emails leave the team, so they carry the key, the title and the
 * fixed-in build only: never comments, links or anything else internal.
 *
 * Without SMTP the console mailer logs the message and no event is written:
 * nothing went out, and a failure on every assignment would only be noise.
 */
import type { Deps } from '../deps';
import { SendError } from '../integrations/errors';
import { dashboardTicketUrl } from '../integrations/context';
import { escapeHtml } from '../integrations/render';
import { ticketKey } from '../repo/tickets';

export type NotifyTo = 'assignee' | 'reporter';

export interface NotifyPayload {
  ticketId: string;
  to: NotifyTo;
  email: string;
  /** The assignee (to = assignee). */
  userId?: string;
  /** Who made the assignment. */
  actorUserId?: string;
}

interface Message {
  subject: string;
  text: string;
  html: string;
}

export function assignedEmail(o: { key: string; title: string; projectName: string; typeLabel: string; actor: string; url: string }): Message {
  const subject = `[Snitch] ${o.key} assigned to you: ${o.title}`.slice(0, 200);
  const text = [`${o.actor} assigned ${o.key} to you.`, '', `${o.key} · ${o.typeLabel} · ${o.projectName}`, o.title, '', `Open in Snitch: ${o.url}`].join('\n');
  const html = card(
    `<tr><td style="font-size:14px;padding-bottom:12px">${escapeHtml(o.actor)} assigned ${escapeHtml(o.key)} to you.</td></tr>
<tr><td style="font-size:12px;color:#6e6e73;padding-bottom:4px">${escapeHtml(o.projectName)} · ${escapeHtml(o.typeLabel)} · ${escapeHtml(o.key)}</td></tr>
<tr><td style="font-size:18px;font-weight:600;padding-bottom:16px">${escapeHtml(o.title)}</td></tr>
<tr><td><a href="${escapeHtml(o.url)}" style="display:inline-block;background:#1d1d1f;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Open in Snitch</a></td></tr>`,
  );
  return { subject, text, html };
}

export function resolvedEmail(o: { key: string; title: string; projectName: string; fixedIn: string | null }): Message {
  const subject = `[${o.projectName}] ${o.key} resolved: ${o.title}`.slice(0, 200);
  const fixed = o.fixedIn ? `Fixed in ${o.fixedIn}.` : null;
  const text = [
    'Thanks for your report.',
    '',
    `${o.key}: ${o.title}`,
    `has been resolved.${fixed ? ` ${fixed}` : ''}`,
    '',
    `You're getting this because you left your email address when you reported it in ${o.projectName}.`,
  ].join('\n');
  const html = card(
    `<tr><td style="font-size:14px;padding-bottom:12px">Thanks for your report.</td></tr>
<tr><td style="font-size:18px;font-weight:600;padding-bottom:8px">${escapeHtml(o.key)}: ${escapeHtml(o.title)}</td></tr>
<tr><td style="font-size:14px;padding-bottom:16px">has been resolved.${fixed ? ` <strong>${escapeHtml(fixed)}</strong>` : ''}</td></tr>
<tr><td style="font-size:12px;color:#6e6e73">You're getting this because you left your email address when you reported it in ${escapeHtml(o.projectName)}.</td></tr>`,
  );
  return { subject, text, html };
}

function card(rows: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
${rows}
</table></body></html>`;
}

/** The `notify` job. Rechecks everything at send time: a reassignment or a reopen since the change cancels it. */
export async function sendNotification(deps: Deps, payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as NotifyPayload;
  const ticket = deps.tickets.get(p.ticketId);
  const project = ticket ? deps.projects.get(ticket.project_id) : null;
  if (!ticket || !project) return;
  const key = ticketKey(project.ticketPrefix, ticket.number);
  let msg: Message;
  let to: string;
  if (p.to === 'assignee') {
    if (!project.notifyAssignees || !p.userId || ticket.assignee_user_id !== p.userId) return;
    const user = deps.users.get(p.userId);
    if (!user || user.disabled_at !== null) return;
    const actor = p.actorUserId ? deps.users.get(p.actorUserId) : null;
    to = user.email;
    msg = assignedEmail({
      key,
      title: ticket.title,
      projectName: project.name,
      typeLabel: project.reportTypes.find((r) => r.id === ticket.type)?.label ?? ticket.type,
      actor: actor ? (actor.name ?? actor.email) : 'Someone',
      url: dashboardTicketUrl(deps, ticket.id),
    });
  } else {
    if (!project.notifyReporters || ticket.status !== 'resolved' || !ticket.reporter_email) return;
    to = ticket.reporter_email;
    msg = resolvedEmail({ key, title: ticket.title, projectName: project.name, fixedIn: ticket.fixed_in });
  }
  if (deps.mailer.driver === 'console') {
    await deps.mailer.send({ to: [to], ...msg });
    return;
  }
  try {
    await deps.mailer.send({ to: [to], ...msg });
  } catch (e) {
    // SMTP 5xx (unknown mailbox, rejected sender) won't fix itself; anything else is worth retrying.
    const code = (e as { responseCode?: unknown }).responseCode;
    const permanent = typeof code === 'number' && code >= 500 && code < 600;
    throw new SendError(`SMTP send failed: ${(e as Error).message}`, !permanent);
  }
  deps.tickets.addEvent(ticket.id, { type: 'system' }, 'notification_sent', { to: p.to, email: to });
}

/** Called once the `notify` job is dead (last retry, or a permanent error). */
export function notificationFailed(deps: Deps, payload: Record<string, unknown>, error: string): void {
  const p = payload as unknown as NotifyPayload;
  if (!deps.tickets.get(p.ticketId)) return;
  deps.tickets.addEvent(p.ticketId, { type: 'system' }, 'notification_failed', { to: p.to, email: p.email, error });
}
