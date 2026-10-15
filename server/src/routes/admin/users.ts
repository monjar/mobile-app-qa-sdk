/**
 * Team management (admin-only) plus jobs and the audit log.
 *
 * Adding someone without a password invites them: they get an email with a
 * link to choose one. Every link is also returned to the admin, who passes it
 * on when the server can't send email.
 */
import { Hono } from 'hono';
import { JOB_STATES, SERVER_FEATURES, UserCreate, UserUpdate, type AccountLink, type JobState, type ServerInfo, type UserCreated } from '@snitch/contract';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { conflict, invalid, notFound } from '../../http/errors';
import { requireAdmin } from '../../http/session';
import { jsonBody } from '../../http/validate';
import { VERSION } from '../../version';
import { backupStatus } from '../../worker/backup';
import { LINK_TTL, sendAccountLink } from '../../mail/account';

export function userRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/server', (c) =>
    c.json({
      version: VERSION,
      publicUrl: deps.config.publicUrl,
      storage: deps.blobs.kind,
      mail: deps.mailer.driver,
      backup: backupStatus(deps),
      features: [...SERVER_FEATURES],
    } satisfies ServerInfo),
  );

  // Everyone can list users (to pick an assignee); only admins manage them.
  app.get('/users', (c) => c.json(deps.users.list()));

  app.post('/users', requireAdmin(), async (c) => {
    const body = await jsonBody(c, UserCreate);
    if (deps.users.getByEmail(body.email)) throw conflict('A user with that email already exists');
    const actor = c.get('user');
    if (body.password !== undefined) {
      const user = await deps.users.create({ email: body.email, name: body.name ?? null, role: body.role, password: body.password });
      deps.audit.add(actor.id, 'user.created', user.id, { email: user.email, role: user.role }, c.get('ip'));
      return c.json({ user, invite: null } satisfies UserCreated, 201);
    }
    const user = deps.users.createInvited({ email: body.email, name: body.name ?? null, role: body.role });
    const invite = await sendAccountLink(deps, deps.users.get(user.id)!, 'invite', LINK_TTL.invite, actor);
    deps.audit.add(actor.id, 'user.invited', user.id, { email: user.email, role: user.role, emailed: invite.emailed }, c.get('ip'));
    return c.json({ user, invite } satisfies UserCreated, 201);
  });

  // A fresh invite link (the old one stops working), for someone who hasn't accepted yet.
  app.post('/users/:id/invite', requireAdmin(), async (c) => {
    const target = deps.users.get(c.req.param('id'));
    if (!target) throw notFound('No such user');
    if (!deps.users.view(target.id)!.pending) throw invalid('They already have a password; send a reset link instead');
    if (target.disabled_at !== null) throw invalid('Enable them first');
    const link = await sendAccountLink(deps, target, 'invite', LINK_TTL.invite, c.get('user'));
    deps.audit.add(c.get('user').id, 'user.invite_resent', target.id, { emailed: link.emailed }, c.get('ip'));
    return c.json(link satisfies AccountLink);
  });

  // A reset link for someone who forgot their password (or never had SMTP to ask for one).
  app.post('/users/:id/reset-link', requireAdmin(), async (c) => {
    const target = deps.users.get(c.req.param('id'));
    if (!target) throw notFound('No such user');
    if (target.disabled_at !== null) throw invalid('Enable them first');
    if (deps.users.view(target.id)!.pending) throw invalid("They haven't accepted their invite yet; resend it instead");
    const link = await sendAccountLink(deps, target, 'reset', LINK_TTL.adminReset, c.get('user'));
    deps.audit.add(c.get('user').id, 'user.reset_link_sent', target.id, { emailed: link.emailed }, c.get('ip'));
    return c.json(link satisfies AccountLink);
  });

  app.patch('/users/:id', requireAdmin(), async (c) => {
    const target = deps.users.get(c.req.param('id'));
    if (!target) throw notFound('No such user');
    const patch = await jsonBody(c, UserUpdate);
    const demoting = (patch.role === 'member' && target.role === 'admin') || (patch.disabled === true && target.role === 'admin');
    if (demoting && deps.users.activeAdminCount() <= 1 && target.disabled_at === null) throw invalid('At least one active admin must remain');
    const view = await deps.users.update(target.id, patch);
    if (patch.disabled || patch.password) deps.sessions.deleteForUser(target.id);
    // Disabling someone or setting their password also ends their API tokens: enabling them later doesn't
    // bring old tokens back, and a password reset signs out every client, not just browsers.
    const tokensRevoked = patch.disabled || patch.password ? deps.apiTokens.revokeForUser(target.id) : 0;
    deps.audit.add(
      c.get('user').id,
      'user.updated',
      target.id,
      { fields: Object.keys(patch).filter((k) => k !== 'password'), passwordReset: !!patch.password, ...(tokensRevoked ? { tokensRevoked } : {}) },
      c.get('ip'),
    );
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
