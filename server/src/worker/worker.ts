/**
 * Background worker: one in-process loop that drains the jobs table.
 *
 * - route_ticket       — after a report completes: apply routing rules (auto → escalate, suggest → note)
 * - escalate           — send one escalation to its integration
 * - stale_upload_sweep — hourly: reports never completed within 24 h become `incomplete` (and are routed)
 * - retention_sweep    — daily: delete tickets past their project's retention, with their blobs
 * - housekeeping       — daily: expired sessions, old finished jobs
 *
 * The loop is guarded (one tick at a time) and `stop()` waits for the tick in
 * flight, so shutdown never cuts a job in half.
 */
import type { Deps } from '../deps';
import { errorMessage, log } from '../log';
import { DAY_MS, HOUR_MS } from '../util/clock';
import type { JobRow } from '../repo/jobs';
import { send, SendError } from '../integrations';

export const JOB = {
  route: 'route_ticket',
  escalate: 'escalate',
  staleSweep: 'stale_upload_sweep',
  retention: 'retention_sweep',
  housekeeping: 'housekeeping',
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

  async [JOB.staleSweep](deps) {
    for (const id of deps.tickets.sweepStale(deps.now() - STALE_UPLOAD_MS)) enqueueRoute(deps, id);
  },

  async [JOB.retention](deps) {
    if (deps.config.retentionDays === 0 && !deps.db.prepare('SELECT 1 FROM projects WHERE retention_days > 0 LIMIT 1').get()) return;
    let total = 0;
    for (;;) {
      const ids = deps.tickets.expired(deps.config.retentionDays);
      if (ids.length === 0) break;
      for (const id of ids) {
        for (const key of deps.tickets.delete(id)) await deps.blobs.delete(key).catch(() => undefined);
        total++;
      }
    }
    if (total) log.info('retention', 'deleted expired tickets', { count: total });
  },

  async [JOB.housekeeping](deps) {
    deps.sessions.purgeExpired();
    deps.jobs.prune(30 * DAY_MS);
  },
};

/** What to do when a job fails: escalations record the error on the ticket. */
function onFailure(deps: Deps, job: JobRow, error: string, dead: boolean): void {
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
