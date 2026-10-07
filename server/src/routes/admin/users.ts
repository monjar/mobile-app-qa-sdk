/**
 * Team management (admin-only) plus jobs and the audit log.
 */
import { Hono } from 'hono';
import { JOB_STATES, UserCreate, UserUpdate, type JobState, type ServerInfo } from '@snitch/contract';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { conflict, invalid, notFound } from '../../http/errors';
import { requireAdmin } from '../../http/session';
import { jsonBody } from '../../http/validate';
import { VERSION } from '../../version';

export function userRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/server', (c) =>
    c.json({ version: VERSION, publicUrl: deps.config.publicUrl, storage: deps.blobs.kind, mail: deps.mailer.driver } satisfies ServerInfo),
  );

  // Everyone can list users (to pick an assignee); only admins manage them.
  app.get('/users', (c) => c.json(deps.users.list()));

  app.post('/users', requireAdmin(), async (c) => {
    const body = await jsonBody(c, UserCreate);
    if (deps.users.getByEmail(body.email)) throw conflict('A user with that email already exists');
    const user = await deps.users.create({ email: body.email, name: body.name ?? null, role: body.role, password: body.password });
    deps.audit.add(c.get('user').id, 'user.created', user.id, { email: user.email, role: user.role }, c.get('ip'));
    return c.json(user, 201);
  });

  app.patch('/users/:id', requireAdmin(), async (c) => {
    const target = deps.users.get(c.req.param('id'));
    if (!target) throw notFound('No such user');
    const patch = await jsonBody(c, UserUpdate);
    const demoting = (patch.role === 'member' && target.role === 'admin') || (patch.disabled === true && target.role === 'admin');
    if (demoting && deps.users.activeAdminCount() <= 1 && target.disabled_at === null) throw invalid('At least one active admin must remain');
    const view = await deps.users.update(target.id, patch);
    if (patch.disabled || patch.password) deps.sessions.deleteForUser(target.id);
    deps.audit.add(c.get('user').id, 'user.updated', target.id, { fields: Object.keys(patch).filter((k) => k !== 'password'), passwordReset: !!patch.password }, c.get('ip'));
    return c.json(view);
  });

  app.get('/jobs', requireAdmin(), (c) => {
    const s = c.req.query('state');
    const state = s && (JOB_STATES as readonly string[]).includes(s) ? (s as JobState) : null;
    return c.json(deps.jobs.list(state));
  });

  app.post('/jobs/:id/retry', requireAdmin(), (c) => {
    const id = Number(c.req.param('id'));
    const job = Number.isInteger(id) ? deps.jobs.get(id) : null;
    if (!job) throw notFound('No such job');
    if (job.kind === 'escalate') {
      const payload = JSON.parse(job.payload_json) as { escalationId?: string };
      const esc = payload.escalationId ? deps.integrations.escalation(payload.escalationId) : null;
      if (esc && esc.state === 'failed') deps.integrations.queueEscalation(esc.ticket_id, esc.integration_id, c.get('user').id);
    }
    deps.jobs.retry(id);
    deps.wake();
    deps.audit.add(c.get('user').id, 'job.retried', String(id), { kind: job.kind }, c.get('ip'));
    return c.json({ ok: true });
  });

  app.get('/audit', requireAdmin(), (c) => {
    const before = c.req.query('before');
    return c.json(deps.audit.list(200, before ? Number(before) : undefined));
  });

  return app;
}
