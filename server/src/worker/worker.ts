/**
 * Background worker: one in-process loop that drains the jobs table.
 *
 * - route_ticket       — after a report completes: apply routing rules (auto → escalate, suggest → note)
 * - escalate           — send one escalation to its integration
 * - github_status      — close or reopen a ticket's GitHub issue to match its status (syncStatus)
 * - github_comment     — post a Snitch comment to the ticket's GitHub issue (syncComments)
 * - notify             — email an assignee or a reporter (project notification flags)
 * - stale_upload_sweep — hourly: reports never completed within 24 h become `incomplete` (and are routed);
 *                        partial uploads and temp files nobody owns are deleted
 * - retention_sweep    — daily: delete tickets past their project's retention, with their blobs, and
 *                        installs not seen for 180 days
 * - housekeeping       — daily: expired sessions, old finished jobs
 * - backup             — every SNITCH_BACKUP_INTERVAL_HOURS: gzipped database copy to the backup target
 *
 * The loop is guarded (one tick at a time) and `stop()` waits for the tick in
 * flight, so shutdown never cuts a job in half.
 */
import { GithubConfig } from '@snitch/contract';
import type { Deps } from '../deps';
import { errorMessage, log } from '../log';
import { DAY_MS, HOUR_MS } from '../util/clock';
import type { JobRow } from '../repo/jobs';
import type { TicketRow } from '../repo/tickets';
import { send, SendError } from '../integrations';
import { syncComment, syncStatus } from '../integrations/githubSync';
import { notificationFailed, sendNotification, type NotifyPayload } from '../mail/notifications';
import { removePartials, sweepTempFiles } from '../storage/partials';
import { INSTALL_RETENTION_MS } from '../repo/installs';
import { backupTarget, runBackup } from './backup';

export const JOB = {
  route: 'route_ticket',
  escalate: 'escalate',
  staleSweep: 'stale_upload_sweep',
  retention: 'retention_sweep',
  housekeeping: 'housekeeping',
  githubStatus: 'github_status',
  githubComment: 'github_comment',
  notify: 'notify',
  backup: 'backup',
} as const;

export const STALE_UPLOAD_MS = DAY_MS;

export function enqueueRoute(deps: Deps, ticketId: string): void {
  deps.jobs.enqueue(JOB.route, { ticketId }, { dedupeKey: `route:${ticketId}` });
}

/** Queues an escalation and its job. Returns false when one is already queued or sent. */
export function escalate(deps: Deps, ticketId: string, integrationId: string, userId: string | null): boolean {
  const esc = deps.integrations.queueEscalation(ticketId, integrationId, userId);
  if (!esc) return false;
  const integ = deps.integrations.get(integrationId);
  deps.tickets.addEvent(ticketId, userId ? { type: 'user', userId } : { type: 'system' }, 'escalation_queued', {
    integrationId,
    integration: integ?.name ?? null,
    kind: integ?.kind ?? null,
  });
  deps.jobs.enqueue(JOB.escalate, { escalationId: esc.id, userId });
  return true;
}

/** Emails the new assignee, unless they assigned themselves or the project opted out. */
export function queueAssignedNotification(deps: Deps, ticket: TicketRow, actorUserId: string, assignedEventId: number): boolean {
  const userId = ticket.assignee_user_id;
  if (!userId || userId === actorUserId || !deps.projects.get(ticket.project_id)?.notifyAssignees) return false;
  const user = deps.users.get(userId);
  if (!user || user.disabled_at !== null) return false;
  const payload: NotifyPayload = { ticketId: ticket.id, to: 'assignee', email: user.email, userId, actorUserId };
  return deps.jobs.enqueue(JOB.notify, { ...payload }, { dedupeKey: `${JOB.notify}:${assignedEventId}`, maxAttempts: 5 }) !== null;
}

/** How many tickets a bulk assignment emails one by one; more than that get one digest. */
export const DIGEST_THRESHOLD = 3;

/**
 * After a bulk assignment: emails the assignee per ticket, or one digest for more than DIGEST_THRESHOLD.
 * `assigned` pairs each ticket with its assignment event (dedupe key).
 */
export function queueBulkAssignedNotification(deps: Deps, assigned: { ticket: TicketRow; eventId: number }[], actorUserId: string): boolean {
  const userId = assigned[0]?.ticket.assignee_user_id;
  if (!userId || userId === actorUserId) return false;
  const notifying = assigned.filter(({ ticket }) => deps.projects.get(ticket.project_id)?.notifyAssignees);
  if (notifying.length <= DIGEST_THRESHOLD) {
    return notifying.map(({ ticket, eventId }) => queueAssignedNotification(deps, ticket, actorUserId, eventId)).some(Boolean);
  }
  const user = deps.users.get(userId);
  if (!user || user.disabled_at !== null) return false;
  const payload: NotifyPayload = {
    ticketId: notifying[0]!.ticket.id,
    ticketIds: notifying.map(({ ticket }) => ticket.id),
    to: 'assignee_digest',
    email: user.email,
    userId,
    actorUserId,
  };
  return deps.jobs.enqueue(JOB.notify, { ...payload }, { dedupeKey: `${JOB.notify}:digest:${notifying[0]!.eventId}`, maxAttempts: 5 }) !== null;
}

/** Emails the reporter that their ticket was resolved, when the project opted in and they left an address. */
export function queueResolvedNotification(deps: Deps, ticket: TicketRow, statusEventId: number): boolean {
  if (ticket.status !== 'resolved' || !ticket.reporter_email || !deps.projects.get(ticket.project_id)?.notifyReporters) return false;
  const payload: NotifyPayload = { ticketId: ticket.id, to: 'reporter', email: ticket.reporter_email };
  return deps.jobs.enqueue(JOB.notify, { ...payload }, { dedupeKey: `${JOB.notify}:${statusEventId}`, maxAttempts: 5 }) !== null;
}

/** The ticket's sent GitHub escalations whose integration syncs `setting`. */
function syncedEscalations(deps: Deps, ticketId: string, setting: 'syncStatus' | 'syncComments') {
  return deps.integrations.sentGithubEscalations(ticketId).filter(({ integration }) => {
    const cfg = GithubConfig.safeParse(JSON.parse(integration.config_json));
    return cfg.success && cfg.data[setting];
  });
}

/** After a user closed a ticket (for whatever reason) or reopened a closed one: close or reopen its GitHub issues. */
export function queueGithubStatusSync(deps: Deps, ticketId: string, statusEventId: number): number {
  let n = 0;
  for (const { escalation } of syncedEscalations(deps, ticketId, 'syncStatus')) {
    if (deps.jobs.enqueue(JOB.githubStatus, { escalationId: escalation.id }, { dedupeKey: `${JOB.githubStatus}:${escalation.id}:${statusEventId}` }) !== null) n++;
  }
  return n;
}

/** After a user commented: post the comment to the ticket's GitHub issues. */
export function queueGithubCommentSync(deps: Deps, ticketId: string, commentEventId: number): number {
  let n = 0;
  for (const { escalation } of syncedEscalations(deps, ticketId, 'syncComments')) {
    const payload = { escalationId: escalation.id, eventId: commentEventId };
    if (deps.jobs.enqueue(JOB.githubComment, payload, { dedupeKey: `${JOB.githubComment}:${escalation.id}:${commentEventId}` }) !== null) n++;
  }
  return n;
}

/** Deletes a ticket with everything it owns on disk or in the bucket. */
export async function deleteTicket(deps: Deps, ticketId: string): Promise<void> {
  const removed = deps.tickets.delete(ticketId);
  for (const key of removed.blobKeys) await deps.blobs.delete(key).catch(() => undefined);
  await removePartials(deps.config.dataDir, removed.attachmentIds);
}

type Handler = (deps: Deps, payload: Record<string, unknown>, job: JobRow) => Promise<void>;

const handlers: Record<string, Handler> = {
  async [JOB.route](deps, payload) {
    const ticket = deps.tickets.get(String(payload.ticketId));
    if (!ticket) return;
    for (const rule of deps.integrations.matchingRules(ticket.project_id, ticket.type)) {
      if (rule.mode === 'auto') escalate(deps, ticket.id, rule.integrationId, null);
      else {
        const integ = deps.integrations.get(rule.integrationId);
        deps.tickets.addEvent(ticket.id, { type: 'system' }, 'escalation_suggested', { integrationId: rule.integrationId, integration: integ?.name ?? null });
      }
    }
  },

  async [JOB.escalate](deps, payload) {
    const esc = deps.integrations.escalation(String(payload.escalationId));
    if (!esc || esc.state !== 'queued') return;
    const integ = deps.integrations.get(esc.integration_id);
    const ticket = deps.tickets.get(esc.ticket_id);
    if (!integ || !ticket) return;
    if (integ.enabled !== 1) throw new SendError(`Integration "${integ.name}" is disabled`, false);
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const result = await send(deps, integ, ticket, userId);
    deps.integrations.markSent(esc.id, result.externalId, result.externalUrl);
    deps.tickets.addEvent(ticket.id, { type: 'integration' }, 'escalated', {
      integrationId: integ.id,
      integration: integ.name,
      kind: integ.kind,
      url: result.externalUrl,
      externalId: result.externalId,
    });
    deps.tickets.touch(ticket.id);
  },

  async [JOB.githubStatus](deps, payload) {
    await syncStatus(deps, String(payload.escalationId));
  },

  async [JOB.githubComment](deps, payload, job) {
    await syncComment(deps, String(payload.escalationId), Number(payload.eventId), job.attempts > 1);
  },

  async [JOB.notify](deps, payload) {
    await sendNotification(deps, payload);
  },

  async [JOB.staleSweep](deps) {
    for (const id of deps.tickets.sweepStale(deps.now() - STALE_UPLOAD_MS)) {
      enqueueRoute(deps, id);
      await removePartials(deps.config.dataDir, deps.tickets.attachments(id).map((a) => a.id));
    }
    const files = await sweepTempFiles(deps, STALE_UPLOAD_MS);
    if (files) log.info('uploads', 'deleted abandoned upload files', { count: files });
  },

  async [JOB.retention](deps) {
    const installs = deps.installs.purge(deps.now() - INSTALL_RETENTION_MS);
    if (installs) log.info('retention', 'forgot installs not seen for 180 days', { count: installs });
    if (deps.config.retentionDays === 0 && !deps.db.prepare('SELECT 1 FROM projects WHERE retention_days > 0 LIMIT 1').get()) return;
    let total = 0;
    for (;;) {
      const ids = deps.tickets.expired(deps.config.retentionDays);
      if (ids.length === 0) break;
      for (const id of ids) {
        await deleteTicket(deps, id);
        total++;
      }
    }
    if (total) log.info('retention', 'deleted expired tickets', { count: total });
  },

  async [JOB.backup](deps) {
    await runBackup(deps, backupTarget(deps), deps.config.backup.keep);
  },

  async [JOB.housekeeping](deps) {
    deps.sessions.purgeExpired();
    deps.accountTokens.purgeExpired();
    deps.deviceCodes.purgeExpired();
    deps.jobs.prune(30 * DAY_MS);
  },
};

/** What to do when a job fails: escalations record the error on the ticket, so do notifications that gave up. */
function onFailure(deps: Deps, job: JobRow, error: string, dead: boolean): void {
  if (job.kind === JOB.notify && dead) notificationFailed(deps, JSON.parse(job.payload_json) as Record<string, unknown>, error);
  if (job.kind !== JOB.escalate) return;
  const payload = JSON.parse(job.payload_json) as { escalationId?: string };
  const esc = payload.escalationId ? deps.integrations.escalation(payload.escalationId) : null;
  if (!esc) return;
  deps.integrations.recordError(esc.id, error, dead);
  if (dead) {
    const integ = deps.integrations.get(esc.integration_id);
    deps.tickets.addEvent(esc.ticket_id, { type: 'integration' }, 'escalation_failed', {
      integrationId: esc.integration_id,
      integration: integ?.name ?? null,
      error,
    });
  }
}

export async function runJob(deps: Deps, job: JobRow): Promise<void> {
  const handler = handlers[job.kind];
  if (!handler) {
    deps.jobs.fail({ ...job, attempts: job.max_attempts }, `Unknown job kind ${job.kind}`);
    return;
  }
  try {
    await handler(deps, JSON.parse(job.payload_json) as Record<string, unknown>, job);
    deps.jobs.succeed(job.id);
  } catch (e) {
    const msg = errorMessage(e);
    const permanent = e instanceof SendError && !e.retryable;
    const dead = deps.jobs.fail(permanent ? { ...job, attempts: job.max_attempts } : job, msg, e instanceof SendError ? e.retryAfterMs : undefined);
    onFailure(deps, job, msg, dead);
    log.warn('worker', `job ${job.kind}#${job.id} failed`, { attempt: job.attempts, dead, error: msg });
  }
}

/** Drains due jobs (at most `max` per call). Exposed for tests. */
export async function drain(deps: Deps, max = 50): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = deps.jobs.claim();
    if (!job) break;
    await runJob(deps, job);
  }
  return n;
}

/** Enqueues the periodic jobs for the current hour/day; dedupe keys make this idempotent. */
export function scheduleRecurring(deps: Deps): void {
  const t = deps.now();
  const hour = Math.floor(t / HOUR_MS);
  const day = Math.floor(t / DAY_MS);
  deps.jobs.enqueue(JOB.staleSweep, {}, { dedupeKey: `${JOB.staleSweep}:${hour}`, maxAttempts: 3 });
  deps.jobs.enqueue(JOB.retention, {}, { dedupeKey: `${JOB.retention}:${day}`, maxAttempts: 3 });
  deps.jobs.enqueue(JOB.housekeeping, {}, { dedupeKey: `${JOB.housekeeping}:${day}`, maxAttempts: 3 });
  // One backup per interval slot (slots are aligned to the epoch, so 24 h means just after midnight UTC).
  const backupEvery = deps.config.backup.intervalHours * HOUR_MS;
  if (backupEvery > 0) deps.jobs.enqueue(JOB.backup, {}, { dedupeKey: `${JOB.backup}:${Math.floor(t / backupEvery)}`, maxAttempts: 3 });
}

export interface Worker {
  stop(): Promise<void>;
  /** Run a tick now (after a report completes) instead of waiting for the interval. */
  poke(): void;
}

export function startWorker(deps: Deps, intervalMs = 1000): Worker {
  deps.jobs.recoverStale(5 * 60_000);
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = (async () => {
      try {
        scheduleRecurring(deps);
        await drain(deps);
      } catch (e) {
        log.error('worker', 'tick failed', { error: errorMessage(e) });
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return {
    poke: () => setImmediate(tick),
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
    },
  };
}
