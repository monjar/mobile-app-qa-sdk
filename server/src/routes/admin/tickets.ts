/**
 * Ticket triage for the dashboard: list, detail, status/assignee/type changes,
 * comments, escalation, deletion, attachment content and share links.
 */
import { Hono } from 'hono';
import {
  CommentCreate,
  EscalationCreate,
  ShareLinkCreate,
  TicketListQuery,
  TicketPatch,
  type TicketDetail,
} from '@snitch/contract';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { HttpError, invalid, notFound } from '../../http/errors';
import { requireAdmin } from '../../http/session';
import { jsonBody, query } from '../../http/validate';
import { serveBlob } from '../../http/range';
import type { TicketRow } from '../../repo/tickets';
import { escalate } from '../../worker/worker';

function getTicket(deps: Deps, id: string): TicketRow {
  const t = deps.tickets.get(id);
  if (!t) throw notFound('No such ticket');
  return t;
}

export function detail(deps: Deps, t: TicketRow): TicketDetail {
  const project = deps.projects.get(t.project_id)!;
  const [summary] = deps.tickets.summaries([t]);
  const meta = deps.tickets.metadata(t);
  const escalations = deps.integrations.escalationViews(t.id);
  const done = new Set(escalations.filter((e) => e.state !== 'failed').map((e) => e.integrationId));
  return {
    ticket: {
      ...summary!,
      description: t.description,
      reporter: { email: t.reporter_email, name: t.reporter_name, id: t.reporter_id },
      trigger: t.trigger,
      reportedAt: t.reported_at,
      duplicateOfId: t.duplicate_of_id,
      app: meta.app,
      device: meta.device,
      sdk: meta.sdk,
      custom: meta.custom,
      stats: meta.stats,
    },
    project: { id: project.id, slug: project.slug, name: project.name, reportTypes: project.reportTypes },
    attachments: deps.tickets.attachmentViews(t.id, deps.config.publicUrl).map((a) => ({ ...a, url: `/api/admin/attachments/${a.id}/content` })),
    events: deps.tickets.events(t.id),
    escalations,
    suggestedIntegrationIds: deps.integrations
      .matchingRules(t.project_id, t.type)
      .map((r) => r.integrationId)
      .filter((id) => !done.has(id)),
  };
}

export function ticketRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/tickets', (c) => c.json(deps.tickets.list(query(c, TicketListQuery), null)));

  app.get('/tickets/:id', (c) => c.json(detail(deps, getTicket(deps, c.req.param('id')))));

  app.patch('/tickets/:id', async (c) => {
    const t = getTicket(deps, c.req.param('id'));
    const patch = await jsonBody(c, TicketPatch);
    const actor = { type: 'user' as const, userId: c.get('user').id };
    if (patch.type !== undefined) {
      const project = deps.projects.get(t.project_id)!;
      if (!project.reportTypes.some((r) => r.id === patch.type) && patch.type !== t.type) throw invalid(`Unknown report type ${patch.type}`);
      deps.tickets.setType(t.id, patch.type, actor);
    }
    if (patch.title !== undefined) deps.tickets.setTitle(t.id, patch.title.trim(), actor);
    if (patch.assigneeUserId !== undefined) {
      if (patch.assigneeUserId !== null && !deps.users.get(patch.assigneeUserId)) throw invalid('Unknown user');
      deps.tickets.setAssignee(t.id, patch.assigneeUserId, actor);
    }
    if (patch.duplicateOfId !== undefined) {
      if (patch.duplicateOfId !== null) {
        const original = deps.tickets.get(patch.duplicateOfId);
        if (!original || original.project_id !== t.project_id || original.id === t.id) throw invalid('Duplicate must point at another ticket in the same project');
      }
      deps.tickets.setDuplicateOf(t.id, patch.duplicateOfId);
      if (patch.duplicateOfId !== null && patch.status === undefined) deps.tickets.setStatus(t.id, 'duplicate', actor);
    }
    if (patch.status !== undefined) deps.tickets.setStatus(t.id, patch.status, actor);
    return c.json(detail(deps, getTicket(deps, t.id)));
  });

  app.post('/tickets/:id/comments', async (c) => {
    const t = getTicket(deps, c.req.param('id'));
    const { body } = await jsonBody(c, CommentCreate);
    deps.tickets.addEvent(t.id, { type: 'user', userId: c.get('user').id }, 'comment', { body });
    deps.tickets.touch(t.id);
    return c.json(detail(deps, getTicket(deps, t.id)), 201);
  });

  app.post('/tickets/:id/escalations', async (c) => {
    const t = getTicket(deps, c.req.param('id'));
    const { integrationId } = await jsonBody(c, EscalationCreate);
    const integ = deps.integrations.get(integrationId);
    if (!integ || integ.project_id !== t.project_id) throw invalid('Unknown integration for this project');
    if (integ.enabled !== 1) throw invalid(`Integration "${integ.name}" is disabled`);
    if (!escalate(deps, t.id, integ.id, c.get('user').id)) throw new HttpError(409, 'conflict', `Already escalated to ${integ.name}`);
    deps.wake();
    return c.json(detail(deps, getTicket(deps, t.id)), 202);
  });

  app.delete('/tickets/:id', requireAdmin(), async (c) => {
    const t = getTicket(deps, c.req.param('id'));
    for (const key of deps.tickets.delete(t.id)) await deps.blobs.delete(key).catch(() => undefined);
    deps.audit.add(c.get('user').id, 'ticket.deleted', t.id, { number: t.number, project: t.project_id }, c.get('ip'));
    return c.json({ ok: true });
  });

  // ── Attachments ──────────────────────────────────────────────────────────

  const content = async (c: import('hono').Context<AppEnv>) => {
    const a = deps.tickets.attachmentById(c.req.param('id')!);
    if (!a || a.state !== 'stored' || !a.storage_key) throw notFound('Attachment not available');
    return serveBlob({
      store: deps.blobs,
      key: a.storage_key,
      size: a.size_bytes ?? 0,
      contentType: a.content_type,
      method: c.req.method,
      rangeHeader: c.req.header('range'),
      filename: `${a.name}${extension(a.content_type)}`,
      cacheControl: 'private, max-age=3600',
    });
  };
  app.get('/attachments/:id/content', content);
  app.on('HEAD', '/attachments/:id/content', content);

  app.post('/attachments/:id/share-links', async (c) => {
    const a = deps.tickets.attachmentById(c.req.param('id'));
    if (!a || a.state !== 'stored') throw notFound('Attachment not available');
    const body = await jsonBody(c, ShareLinkCreate);
    const link = deps.tickets.createShareLink(a.id, body.expiresInDays ?? 30, c.get('user').id);
    const url = `${deps.config.publicUrl}/s/${link.token}`;
    deps.tickets.addEvent(a.ticket_id, { type: 'user', userId: c.get('user').id }, 'share_link_created', { attachment: a.name, linkId: link.id, expiresAt: link.expiresAt });
    return c.json({ id: link.id, url, createdAt: deps.now(), expiresAt: link.expiresAt, revokedAt: null }, 201);
  });

  app.delete('/share-links/:id', (c) => {
    const link = deps.tickets.shareLink(c.req.param('id'));
    if (!link) throw notFound('No such share link');
    deps.tickets.revokeShareLink(link.id);
    deps.tickets.addEvent(link.ticket_id, { type: 'user', userId: c.get('user').id }, 'share_link_revoked', { linkId: link.id });
    return c.json({ ok: true });
  });

  return app;
}

export function extension(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'video/mp4':
      return '.mp4';
    case 'application/x-ndjson':
      return '.ndjson';
    default:
      return '.txt';
  }
}
